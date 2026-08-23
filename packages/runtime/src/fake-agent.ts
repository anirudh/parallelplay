import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Clock } from "@parallelplay/kernel";
import type {
  AgentDriver,
  DriverEventBatch,
  DriverReceiptCollection,
  DriverStartRequest,
  LegacyLaunchRequest
} from "./driver.js";

export type FakeAgentScenario =
  | { kind: "immediate_success" }
  | { kind: "success_after"; inspections: number }
  | { kind: "retryable_failure" }
  | { kind: "hang" };

export interface FakeAgentMigrationStatus {
  databaseExists: boolean;
  currentVersion: number;
  latestVersion: 1;
  pendingVersions: number[];
}

const systemClock: Clock = { now: () => new Date() };

function configure(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
}

function currentVersion(databasePath: string): number {
  if (!existsSync(databasePath)) return 0;
  const database = new Database(databasePath, { fileMustExist: true });
  configure(database);
  try {
    const table = database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      )
      .get();
    if (!table) return 0;
    const row = database
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    return row.version;
  } finally {
    database.close();
  }
}

export async function getFakeAgentMigrationStatus(
  databasePath: string
): Promise<FakeAgentMigrationStatus> {
  const version = currentVersion(databasePath);
  return {
    databaseExists: existsSync(databasePath),
    currentVersion: version,
    latestVersion: 1,
    pendingVersions: version < 1 ? [1] : []
  };
}

export async function migrateFakeAgentDatabase(options: {
  databasePath: string;
  clock?: Clock;
}): Promise<FakeAgentMigrationStatus & { appliedVersions: number[] }> {
  const existed = existsSync(options.databasePath);
  const database = new Database(options.databasePath);
  configure(database);
  try {
    if (!existed) {
      try {
        chmodSync(options.databasePath, 0o600);
      } catch {
        // Best effort on platforms without POSIX file modes.
      }
    }
    const version = currentVersionFromConnection(database);
    const appliedVersions: number[] = [];
    if (version < 1) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE fake_runs (
            external_run_id TEXT PRIMARY KEY,
            effect_key TEXT NOT NULL UNIQUE,
            capability TEXT NOT NULL,
            scenario TEXT NOT NULL CHECK (
              scenario IN ('immediate_success', 'success_after', 'retryable_failure', 'hang')
            ),
            remaining_inspections INTEGER NOT NULL CHECK (remaining_inspections >= 0),
            status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
            inspect_calls INTEGER NOT NULL DEFAULT 0 CHECK (inspect_calls >= 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          CREATE TABLE fake_effects (
            effect_key TEXT PRIMARY KEY,
            effect_type TEXT NOT NULL CHECK (effect_type IN ('agent.start', 'agent.cancel')),
            external_run_id TEXT NOT NULL,
            logical_result TEXT NOT NULL,
            call_count INTEGER NOT NULL CHECK (call_count > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
        `);
        database
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
          .run((options.clock ?? systemClock).now().toISOString());
        database.exec("COMMIT");
        appliedVersions.push(1);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
    return { ...(await getFakeAgentMigrationStatus(options.databasePath)), appliedVersions };
  } finally {
    database.close();
  }
}

function currentVersionFromConnection(database: Database.Database): number {
  const table = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get();
  if (!table) return 0;
  const row = database
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };
  return row.version;
}

function scenarioForCapability(capability: string): FakeAgentScenario {
  const successAfter = /^fake\.success-after-(\d+)$/.exec(capability);
  if (successAfter?.[1]) {
    return { kind: "success_after", inspections: Math.max(1, Number(successAfter[1])) };
  }
  if (capability === "fake.retryable-failure") return { kind: "retryable_failure" };
  if (capability === "fake.hang") return { kind: "hang" };
  return { kind: "immediate_success" };
}

export interface SqliteFakeAgentDriverOptions {
  databasePath: string;
  clock?: Clock;
  scenarioResolver?: (request: LegacyLaunchRequest) => FakeAgentScenario;
}

export class SqliteFakeAgentDriver implements AgentDriver {
  readonly name = "fake" as const;
  readonly #database: Database.Database;
  readonly #clock: Clock;
  readonly #scenarioResolver: (request: LegacyLaunchRequest) => FakeAgentScenario;
  #closed = false;

  constructor(options: SqliteFakeAgentDriverOptions) {
    this.#database = new Database(options.databasePath, { fileMustExist: true });
    configure(this.#database);
    if (currentVersionFromConnection(this.#database) !== 1) {
      this.#database.close();
      throw new Error("Fake-agent database requires migration");
    }
    this.#clock = options.clock ?? systemClock;
    this.#scenarioResolver =
      options.scenarioResolver ?? ((request) => scenarioForCapability(request.capability));
  }

  async start(effectKey: string, request: DriverStartRequest): Promise<string> {
    this.#assertOpen();
    if (request.driver === "generic-command") {
      throw new Error("Fake driver only accepts legacy requests");
    }
    const transaction = this.#database.transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT effect_type AS effectType, external_run_id AS externalRunId
           FROM fake_effects WHERE effect_key = ?`
        )
        .get(effectKey) as { effectType: string; externalRunId: string } | undefined;
      const now = this.#clock.now().toISOString();
      if (existing) {
        if (existing.effectType !== "agent.start") throw new Error("Effect key type conflict");
        this.#database
          .prepare(
            "UPDATE fake_effects SET call_count = call_count + 1, updated_at = ? WHERE effect_key = ?"
          )
          .run(now, effectKey);
        return existing.externalRunId;
      }
      const externalRunId = `fake:${effectKey}`;
      const scenario = this.#scenarioResolver(request);
      const status = scenario.kind === "immediate_success" ? "succeeded" : "running";
      const remaining = scenario.kind === "success_after" ? scenario.inspections : 0;
      this.#database
        .prepare(
          `INSERT INTO fake_runs
            (external_run_id, effect_key, capability, scenario, remaining_inspections, status,
             inspect_calls, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
        )
        .run(
          externalRunId,
          effectKey,
          request.capability,
          scenario.kind,
          remaining,
          status,
          now,
          now
        );
      this.#database
        .prepare(
          `INSERT INTO fake_effects
            (effect_key, effect_type, external_run_id, logical_result, call_count, created_at, updated_at)
           VALUES (?, 'agent.start', ?, ?, 1, ?, ?)`
        )
        .run(effectKey, externalRunId, externalRunId, now, now);
      return externalRunId;
    });
    return transaction();
  }

  async inspect(externalRunId: string, afterSequence = 0): Promise<DriverEventBatch> {
    this.#assertOpen();
    const transaction = this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT scenario, remaining_inspections AS remainingInspections, status
           FROM fake_runs WHERE external_run_id = ?`
        )
        .get(externalRunId) as
        { scenario: string; remainingInspections: number; status: string } | undefined;
      if (!row) throw new Error(`Unknown fake external run: ${externalRunId}`);
      const terminal = (
        outcome: "succeeded" | "failed" | "operator_cancelled",
        detail?: string
      ): DriverEventBatch => ({
        afterSequence,
        events:
          afterSequence === 0
            ? [
                {
                  schemaVersion: 1,
                  sequence: 1,
                  type: "terminal",
                  outcome,
                  ...(detail ? { detail } : {})
                }
              ]
            : [],
        status: outcome,
        exitCode: outcome === "succeeded" ? 0 : 1
      });
      const running = (): DriverEventBatch => ({
        afterSequence,
        events: [],
        status: "running",
        exitCode: null
      });
      if (row.status === "succeeded") return terminal("succeeded");
      if (row.status === "failed") {
        return terminal("failed", "deterministic fake driver failure");
      }
      if (row.status === "cancelled") {
        return terminal("operator_cancelled", "fake external run was cancelled");
      }
      const now = this.#clock.now().toISOString();
      if (row.scenario === "retryable_failure") {
        this.#database
          .prepare(
            `UPDATE fake_runs SET status = 'failed', inspect_calls = inspect_calls + 1,
             updated_at = ? WHERE external_run_id = ?`
          )
          .run(now, externalRunId);
        return terminal("failed", "deterministic fake driver failure");
      }
      if (row.scenario === "success_after") {
        const remaining = Math.max(0, row.remainingInspections - 1);
        const status = remaining === 0 ? "succeeded" : "running";
        this.#database
          .prepare(
            `UPDATE fake_runs SET remaining_inspections = ?, status = ?,
             inspect_calls = inspect_calls + 1, updated_at = ? WHERE external_run_id = ?`
          )
          .run(remaining, status, now, externalRunId);
        return status === "succeeded" ? terminal("succeeded") : running();
      }
      this.#database
        .prepare(
          "UPDATE fake_runs SET inspect_calls = inspect_calls + 1, updated_at = ? WHERE external_run_id = ?"
        )
        .run(now, externalRunId);
      return running();
    });
    return transaction();
  }

  async cancel(effectKey: string, externalRunId: string): Promise<"cancelled"> {
    this.#assertOpen();
    const transaction = this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT effect_type AS effectType FROM fake_effects WHERE effect_key = ?")
        .get(effectKey) as { effectType: string } | undefined;
      const now = this.#clock.now().toISOString();
      if (existing) {
        if (existing.effectType !== "agent.cancel") throw new Error("Effect key type conflict");
        this.#database
          .prepare(
            "UPDATE fake_effects SET call_count = call_count + 1, updated_at = ? WHERE effect_key = ?"
          )
          .run(now, effectKey);
        return "cancelled" as const;
      }
      const result = this.#database
        .prepare(
          "UPDATE fake_runs SET status = 'cancelled', updated_at = ? WHERE external_run_id = ?"
        )
        .run(now, externalRunId);
      if (result.changes === 0) throw new Error(`Unknown fake external run: ${externalRunId}`);
      this.#database
        .prepare(
          `INSERT INTO fake_effects
            (effect_key, effect_type, external_run_id, logical_result, call_count, created_at, updated_at)
           VALUES (?, 'agent.cancel', ?, 'cancelled', 1, ?, ?)`
        )
        .run(effectKey, externalRunId, now, now);
      return "cancelled" as const;
    });
    return transaction();
  }

  async collectReceipt(externalRunId: string): Promise<DriverReceiptCollection> {
    void externalRunId;
    throw new Error("Legacy fake runs do not produce structured driver receipts");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Fake agent driver is closed");
  }
}
