import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { sha256 } from "./canonical.js";
import { KernelSetupError } from "./errors.js";

export type SqliteDatabase = Database.Database;

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };

interface Migration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

export interface MigrationStatus {
  databaseExists: boolean;
  currentVersion: number;
  latestVersion: number;
  pendingVersions: number[];
  driftedVersions: number[];
  unknownAppliedVersions: number[];
}

export interface MigrationResult extends MigrationStatus {
  appliedVersions: number[];
}

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function loadMigrations(): Migration[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const match = /^(\d{3})_/.exec(name);
      if (!match?.[1]) throw new Error(`Invalid migration filename: ${name}`);
      const sql = readFileSync(`${migrationsDirectory}/${name}`, "utf8");
      return { version: Number(match[1]), name, checksum: sha256(sql), sql };
    });
}

export function configureDatabase(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
}

export function openDatabase(databasePath: string, fileMustExist = true): SqliteDatabase {
  const database = new Database(databasePath, { fileMustExist });
  configureDatabase(database);
  return database;
}

export function openReadOnlyDatabase(databasePath: string): SqliteDatabase {
  const database = new Database(databasePath, { fileMustExist: true, readonly: true });
  database.pragma("foreign_keys = ON");
  database.pragma("query_only = ON");
  database.pragma("busy_timeout = 5000");
  return database;
}

function ensureMigrationTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_update
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'schema migrations are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'schema migrations are immutable');
    END;
  `);
}

function readAppliedMigrations(
  database: SqliteDatabase
): Map<number, { name: string; checksum: string }> {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get();
  if (!table) return new Map();
  const rows = database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string; checksum: string }[];
  return new Map(rows.map((row) => [row.version, { name: row.name, checksum: row.checksum }]));
}

function findUnknownAppliedVersions(
  migrations: Migration[],
  applied: Map<number, { name: string; checksum: string }>
): number[] {
  const knownVersions = new Set(migrations.map((migration) => migration.version));
  return [...applied.keys()].filter((version) => !knownVersions.has(version)).sort((a, b) => a - b);
}

function assertNoUnknownAppliedVersions(
  migrations: Migration[],
  applied: Map<number, { name: string; checksum: string }>
): void {
  const unknownAppliedVersions = findUnknownAppliedVersions(migrations, applied);
  if (unknownAppliedVersions.length > 0) {
    throw new KernelSetupError(
      "MIGRATION_AHEAD",
      "Database contains migrations unknown to this ParallelPlay build",
      { version: unknownAppliedVersions[0] ?? 0 }
    );
  }
}

function calculateMigrationStatus(databasePath: string): MigrationStatus {
  const migrations = loadMigrations();
  if (!existsSync(databasePath)) {
    return {
      databaseExists: false,
      currentVersion: 0,
      latestVersion: migrations.at(-1)?.version ?? 0,
      pendingVersions: migrations.map((migration) => migration.version),
      driftedVersions: [],
      unknownAppliedVersions: []
    };
  }

  const database = openDatabase(databasePath);
  try {
    const applied = readAppliedMigrations(database);
    const driftedVersions = migrations
      .filter((migration) => {
        const stored = applied.get(migration.version);
        return (
          stored !== undefined &&
          (stored.checksum !== migration.checksum || stored.name !== migration.name)
        );
      })
      .map((migration) => migration.version);
    return {
      databaseExists: true,
      currentVersion: Math.max(0, ...applied.keys()),
      latestVersion: migrations.at(-1)?.version ?? 0,
      pendingVersions: migrations
        .filter((migration) => !applied.has(migration.version))
        .map((migration) => migration.version),
      driftedVersions,
      unknownAppliedVersions: findUnknownAppliedVersions(migrations, applied)
    };
  } finally {
    database.close();
  }
}

export async function getMigrationStatus(databasePath: string): Promise<MigrationStatus> {
  return calculateMigrationStatus(databasePath);
}

export async function migrateDatabase(options: {
  databasePath: string;
  clock?: Clock;
}): Promise<MigrationResult> {
  const migrations = loadMigrations();
  const existed = existsSync(options.databasePath);
  const database = openDatabase(options.databasePath, false);
  const appliedVersions: number[] = [];
  try {
    if (!existed) {
      try {
        chmodSync(options.databasePath, 0o600);
      } catch {
        // File modes are best-effort on platforms without POSIX permissions.
      }
    }
    const applied = readAppliedMigrations(database);
    assertNoUnknownAppliedVersions(migrations, applied);
    ensureMigrationTable(database);
    for (const migration of migrations) {
      const stored = applied.get(migration.version);
      if (stored) {
        if (stored.checksum !== migration.checksum || stored.name !== migration.name) {
          throw new KernelSetupError(
            "MIGRATION_DRIFT",
            "Applied migration does not match its source",
            {
              version: migration.version
            }
          );
        }
        continue;
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
          )
          .run(
            migration.version,
            migration.name,
            migration.checksum,
            (options.clock ?? systemClock).now().toISOString()
          );
        database.exec("COMMIT");
        appliedVersions.push(migration.version);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    database.close();
  }
  return { ...calculateMigrationStatus(options.databasePath), appliedVersions };
}

export function assertMigrationsCurrent(databasePath: string): void {
  const status = calculateMigrationStatus(databasePath);
  if (!status.databaseExists) {
    throw new KernelSetupError("DATABASE_NOT_FOUND", "Database does not exist");
  }
  if (status.unknownAppliedVersions.length > 0) {
    throw new KernelSetupError(
      "MIGRATION_AHEAD",
      "Database contains migrations unknown to this ParallelPlay build",
      { version: status.unknownAppliedVersions[0] ?? 0 }
    );
  }
  if (status.driftedVersions.length > 0) {
    throw new KernelSetupError("MIGRATION_DRIFT", "Applied migrations have checksum drift", {
      version: status.driftedVersions[0] ?? 0
    });
  }
  if (status.pendingVersions.length > 0) {
    throw new KernelSetupError("MIGRATION_REQUIRED", "Database has pending migrations", {
      nextVersion: status.pendingVersions[0] ?? 0
    });
  }
}
