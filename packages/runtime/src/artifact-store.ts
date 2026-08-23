import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import type { ArtifactEntry } from "@parallelplay/kernel";
import type { StoreStatus } from "./source-store.js";

const MARKER = ".parallelplay-artifact-store.json";
const FORMAT = { kind: "parallelplay-artifact-store", schemaVersion: 1, digest: "sha256" } as const;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1000 &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

export function getArtifactStoreStatus(root: string): StoreStatus {
  const marker = join(resolve(root), MARKER);
  if (!existsSync(marker)) return { exists: false, valid: false, schemaVersion: null };
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    return {
      exists: true,
      valid:
        value["kind"] === FORMAT.kind &&
        value["schemaVersion"] === FORMAT.schemaVersion &&
        value["digest"] === FORMAT.digest,
      schemaVersion: typeof value["schemaVersion"] === "number" ? value["schemaVersion"] : null
    };
  } catch {
    return { exists: true, valid: false, schemaVersion: null };
  }
}

export function initializeArtifactStore(root: string): StoreStatus {
  const absolute = resolve(root);
  mkdirSync(join(absolute, "sha256"), { recursive: true, mode: 0o700 });
  const marker = join(absolute, MARKER);
  if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify(FORMAT)}\n`, { mode: 0o600 });
  const status = getArtifactStoreStatus(root);
  if (!status.valid) throw new Error("Artifact store has an unsupported format");
  return status;
}

export interface ArtifactStore {
  put(path: string, role: string, bytes: Uint8Array): ArtifactEntry;
  read(entry: ArtifactEntry): Uint8Array;
  verify(entries: ArtifactEntry[]): { valid: boolean; failures: string[] };
}

export class FileArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    if (!getArtifactStoreStatus(root).valid) {
      throw new Error("Artifact store must be initialized before use");
    }
    this.#root = resolve(root);
  }

  objectPath(sha256: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact SHA-256 digest");
    return join(this.#root, "sha256", sha256.slice(0, 2), sha256.slice(2));
  }

  put(path: string, role: string, bytes: Uint8Array): ArtifactEntry {
    if (!validArtifactPath(path)) throw new Error("Artifact path must be normalized and relative");
    if (!/^[a-z][a-z0-9._-]{0,99}$/.test(role)) throw new Error("Invalid artifact role");
    if (bytes.byteLength > 268_435_456) throw new Error("Artifact exceeds 256 MiB");
    const sha256 = digest(bytes);
    const destination = this.objectPath(sha256);
    mkdirSync(join(this.#root, "sha256", sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    if (existsSync(destination)) {
      const existing = readFileSync(destination);
      if (digest(existing) !== sha256) throw new Error("Artifact CAS object is corrupt");
    } else {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        linkSync(temporary, destination);
      } catch (error) {
        const candidate = error as NodeJS.ErrnoException;
        if (candidate.code !== "EEXIST") throw error;
        if (digest(readFileSync(destination)) !== sha256) {
          throw new Error("Artifact CAS object is corrupt", { cause: error });
        }
      } finally {
        unlinkSync(temporary);
      }
    }
    return { path, role, size: bytes.byteLength, sha256 };
  }

  read(entry: ArtifactEntry): Uint8Array {
    const integrity = this.verify([entry]);
    if (!integrity.valid) throw new Error(integrity.failures.join("; "));
    return readFileSync(this.objectPath(entry.sha256));
  }

  verify(entries: ArtifactEntry[]): { valid: boolean; failures: string[] } {
    const failures: string[] = [];
    for (const entry of entries) {
      if (!validArtifactPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        failures.push(`${entry.path}: invalid manifest entry`);
        continue;
      }
      const path = this.objectPath(entry.sha256);
      if (!existsSync(path)) {
        failures.push(`${entry.path}: missing`);
        continue;
      }
      const size = statSync(path).size;
      const actual = digest(readFileSync(path));
      if (size !== entry.size || actual !== entry.sha256)
        failures.push(`${entry.path}: digest mismatch`);
    }
    return { valid: failures.length === 0, failures };
  }
}
