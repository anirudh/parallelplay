import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  CandidateDiffEntryV1,
  SourceRevisionIdentity,
  SourceRevisionState
} from "@parallelplay/kernel";
import { sourceRevisionDigest } from "@parallelplay/kernel";

const execFileAsync = promisify(execFile);
const MARKER = ".parallelplay-source-store.json";
const FORMAT = { kind: "parallelplay-source-store", schemaVersion: 1 } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoreStatus {
  exists: boolean;
  valid: boolean;
  schemaVersion: number | null;
}

export function getSourceStoreStatus(root: string): StoreStatus {
  const marker = join(resolve(root), MARKER);
  if (!existsSync(marker)) return { exists: false, valid: false, schemaVersion: null };
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    return {
      exists: true,
      valid: value["kind"] === FORMAT.kind && value["schemaVersion"] === FORMAT.schemaVersion,
      schemaVersion: typeof value["schemaVersion"] === "number" ? value["schemaVersion"] : null
    };
  } catch {
    return { exists: true, valid: false, schemaVersion: null };
  }
}

export function initializeSourceStore(root: string): StoreStatus {
  const absolute = resolve(root);
  mkdirSync(join(absolute, "repositories"), { recursive: true, mode: 0o700 });
  mkdirSync(join(absolute, "captures"), { recursive: true, mode: 0o700 });
  const marker = join(absolute, MARKER);
  if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify(FORMAT)}\n`, { mode: 0o600 });
  const status = getSourceStoreStatus(absolute);
  if (!status.valid) throw new Error("Source store has an unsupported format");
  return status;
}

export interface CaptureRevisionRequest {
  repositoryId: string;
  revisionId: string;
  captureKey: string;
  repositoryPath: string;
  ref: string;
}

export interface CapturedRevision extends SourceRevisionIdentity {
  revisionId: string;
  storageRef: string;
  revisionDigest: string;
}

export interface GitRevisionStore {
  capture(request: CaptureRevisionRequest): Promise<CapturedRevision>;
  checkout(revision: SourceRevisionState, destination: string): Promise<void>;
  removeCheckout(revision: SourceRevisionState, destination: string): Promise<void>;
  status(checkout: string): Promise<string>;
  verify(revision: SourceRevisionState): Promise<{ valid: boolean; reason: string | null }>;
  materializePlain(revision: SourceRevisionState, destination: string): Promise<void>;
  captureCandidate(request: CaptureCandidateRequest): Promise<CapturedRevision>;
  candidateDiff(
    baseRevision: SourceRevisionState,
    candidateRevision: SourceRevisionState
  ): Promise<CandidateDiffEntryV1[]>;
  initializeIntegrationRef(targetId: string, initialHead: SourceRevisionState): Promise<string>;
  readIntegrationHead(targetId: string, repositoryId: string): Promise<string>;
  prepareIntegrationRevision(
    request: PrepareIntegrationRevisionRequest
  ): Promise<PreparedIntegrationRevision>;
  promoteIntegrationRef(request: PromoteIntegrationRefRequest): Promise<{ duplicate: boolean }>;
}

async function git(
  args: string[],
  cwd?: string,
  extraEnvironment: Record<string, string> = {}
): Promise<string> {
  const result = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnvironment
    }
  });
  return result.stdout.trim();
}

async function gitRaw(
  args: string[],
  cwd?: string,
  extraEnvironment: Record<string, string> = {}
): Promise<string> {
  const result = await execFileAsync("git", args, {
    ...(cwd ? { cwd } : {}),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnvironment
    }
  });
  return result.stdout;
}

export interface CaptureCandidateRequest {
  revisionId: string;
  captureKey: string;
  baseRevision: SourceRevisionState;
  workspacePath: string;
  attemptStartedAt: string;
  attemptId: string;
  maxFiles?: number;
  maxBytes?: number;
}

export interface PrepareIntegrationRevisionRequest {
  targetId: string;
  revisionId: string;
  captureKey: string;
  baseRevision: SourceRevisionState;
  candidateRevision: SourceRevisionState;
  expectedHeadRevision: SourceRevisionState;
  candidateId: string;
  preparedAt: string;
}

export type PreparedIntegrationRevision =
  | { outcome: "prepared"; revision: CapturedRevision }
  | { outcome: "conflicted"; mergeBaseOid: string; paths: string[] };

export interface PromoteIntegrationRefRequest {
  targetId: string;
  repositoryId: string;
  expectedOldCommitOid: string;
  newCommitOid: string;
}

function validateCandidateTree(root: string, maxFiles: number, maxBytes: number): void {
  let files = 0;
  let bytes = 0;
  const visit = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === ".git") throw new Error("Candidate workspace contains forbidden .git material");
      const path = join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Candidate workspace contains symlink: ${child}`);
      if (stat.isDirectory()) {
        visit(path, child);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Candidate workspace contains special file: ${child}`);
      files += 1;
      bytes += stat.size;
      if (files > maxFiles) throw new Error("Candidate workspace exceeds file-count limit");
      if (bytes > maxBytes) throw new Error("Candidate workspace exceeds byte limit");
    }
  };
  visit(root, "");
}

async function validateGitTree(repository: string, commitOid: string): Promise<void> {
  const tree = await git(["--git-dir", repository, "ls-tree", "-r", "-z", commitOid]);
  for (const entry of tree.split("\0")) {
    if (!entry) continue;
    const mode = entry.slice(0, 6);
    if (mode === "160000")
      throw new Error("Source revision contains a forbidden gitlink/submodule");
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new Error(`Source revision contains unsupported Git mode ${mode}`);
    }
  }
}

interface CaptureIntent extends SourceRevisionIdentity {
  schemaVersion: 1;
  revisionId: string;
  captureKey: string;
  storageRef: string;
}

function parseCaptureIntent(path: string): CaptureIntent | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CaptureIntent>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.revisionId !== "string" ||
    typeof value.repositoryId !== "string" ||
    typeof value.captureKey !== "string" ||
    (value.objectFormat !== "sha1" && value.objectFormat !== "sha256") ||
    typeof value.commitOid !== "string" ||
    typeof value.treeOid !== "string" ||
    typeof value.storageRef !== "string"
  ) {
    throw new Error("Capture intent is corrupt or unsupported");
  }
  return value as CaptureIntent;
}

function persistCaptureIntent(path: string, intent: CaptureIntent): CaptureIntent {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, path);
    return intent;
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code !== "EEXIST") throw error;
    const existing = parseCaptureIntent(path);
    if (!existing) {
      throw new Error("Capture intent disappeared during creation", { cause: error });
    }
    return existing;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class ManagedGitRevisionStore implements GitRevisionStore {
  readonly #root: string;

  constructor(root: string) {
    const status = getSourceStoreStatus(root);
    if (!status.valid) throw new Error("Source store must be initialized before use");
    this.#root = resolve(root);
  }

  repositoryPath(repositoryId: string): string {
    if (!UUID_PATTERN.test(repositoryId)) throw new Error("Repository ID must be a UUID");
    return join(this.#root, "repositories", `${repositoryId}.git`);
  }

  async capture(request: CaptureRevisionRequest): Promise<CapturedRevision> {
    if (!UUID_PATTERN.test(request.revisionId)) throw new Error("Revision ID must be a UUID");
    const repository = this.repositoryPath(request.repositoryId);
    const storageRef = `refs/parallelplay/revisions/${request.revisionId}`;
    if (!request.captureKey || request.captureKey.length > 200) {
      throw new Error("Capture key must contain 1 to 200 characters");
    }
    const source = resolve(request.repositoryPath);
    if (
      request.ref.length === 0 ||
      request.ref.length > 500 ||
      request.ref.startsWith("-") ||
      request.ref.includes("\0")
    ) {
      throw new Error("Git ref is invalid");
    }
    const intentPath = join(this.#root, "captures", `${request.revisionId}.json`);
    let intent = parseCaptureIntent(intentPath);
    if (!intent) {
      const detectedObjectFormat = await git(["rev-parse", "--show-object-format"], source);
      if (detectedObjectFormat !== "sha1" && detectedObjectFormat !== "sha256") {
        throw new Error(`Unsupported Git object format: ${detectedObjectFormat}`);
      }
      const objectFormat = detectedObjectFormat;
      const commitOid = await git(["rev-parse", "--verify", `${request.ref}^{commit}`], source);
      const treeOid = await git(["rev-parse", "--verify", `${commitOid}^{tree}`], source);
      intent = persistCaptureIntent(intentPath, {
        schemaVersion: 1,
        revisionId: request.revisionId,
        repositoryId: request.repositoryId,
        captureKey: request.captureKey,
        objectFormat,
        commitOid,
        treeOid,
        storageRef
      });
    }
    if (
      intent.revisionId !== request.revisionId ||
      intent.repositoryId !== request.repositoryId ||
      intent.storageRef !== storageRef
    ) {
      throw new Error("Revision ID already belongs to another repository capture");
    }
    if (intent.captureKey !== request.captureKey) {
      const requestedCommit = await git(
        ["rev-parse", "--verify", `${request.ref}^{commit}`],
        source
      );
      if (requestedCommit !== intent.commitOid) {
        throw new Error("Revision ID already pins another commit");
      }
    }
    const { objectFormat, commitOid, treeOid } = intent;
    if (!existsSync(repository)) {
      mkdirSync(dirname(repository), { recursive: true, mode: 0o700 });
      await git(["init", "--bare", `--object-format=${objectFormat}`, repository]);
      chmodSync(repository, 0o700);
    } else {
      const existingFormat = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--show-object-format"
      ]);
      if (existingFormat !== objectFormat) throw new Error("Repository object format conflict");
    }
    const existing = await git([
      "--git-dir",
      repository,
      "rev-parse",
      "--verify",
      storageRef
    ]).catch(() => "");
    if (existing && existing !== commitOid)
      throw new Error("Revision ID already pins another commit");
    if (!existing) {
      await git([
        "--git-dir",
        repository,
        "fetch",
        "--no-tags",
        "--force",
        source,
        `${commitOid}:${storageRef}`
      ]);
    }
    const importedCommit = await git([
      "--git-dir",
      repository,
      "rev-parse",
      "--verify",
      `${storageRef}^{commit}`
    ]);
    const importedTree = await git([
      "--git-dir",
      repository,
      "rev-parse",
      "--verify",
      `${storageRef}^{tree}`
    ]);
    if (importedCommit !== commitOid || importedTree !== treeOid) {
      throw new Error("Imported Git revision does not match the resolved revision");
    }
    const identity = { repositoryId: request.repositoryId, objectFormat, commitOid, treeOid };
    return {
      revisionId: request.revisionId,
      storageRef,
      ...identity,
      revisionDigest: sourceRevisionDigest(identity)
    };
  }

  async materializePlain(revision: SourceRevisionState, destination: string): Promise<void> {
    const valid = await this.verify(revision);
    if (!valid.valid) throw new Error(valid.reason ?? "Base revision is invalid");
    const absolute = resolve(destination);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (readdirSync(absolute).length > 0)
      throw new Error("Plain workspace destination is not empty");
    const temporary = mkdtempSync(join(this.#root, "captures", "materialize-"));
    try {
      const index = join(temporary, "index");
      const environment = { GIT_INDEX_FILE: index };
      const repository = this.repositoryPath(revision.repositoryId);
      await validateGitTree(repository, revision.commitOid);
      await git(["--git-dir", repository, "read-tree", revision.commitOid], undefined, environment);
      await git(
        [
          "--git-dir",
          repository,
          `--work-tree=${absolute}`,
          "checkout-index",
          "--all",
          `--prefix=${absolute}/`
        ],
        undefined,
        environment
      );
      if (existsSync(join(absolute, ".git"))) {
        throw new Error("Plain workspace unexpectedly contains .git material");
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async captureCandidate(request: CaptureCandidateRequest): Promise<CapturedRevision> {
    if (!UUID_PATTERN.test(request.revisionId)) throw new Error("Revision ID must be a UUID");
    if (!request.captureKey || request.captureKey.length > 200) {
      throw new Error("Capture key must contain 1 to 200 characters");
    }
    if (!UUID_PATTERN.test(request.attemptId)) throw new Error("Attempt ID must be a UUID");
    const workspace = resolve(request.workspacePath);
    if (!statSync(workspace).isDirectory())
      throw new Error("Candidate workspace is not a directory");
    validateCandidateTree(
      workspace,
      request.maxFiles ?? 100_000,
      request.maxBytes ?? 1_073_741_824
    );
    const valid = await this.verify(request.baseRevision);
    if (!valid.valid) throw new Error(valid.reason ?? "Base revision is invalid");
    const storageRef = `refs/parallelplay/revisions/${request.revisionId}`;
    const intentPath = join(this.#root, "captures", `${request.revisionId}.json`);
    const existingIntent = parseCaptureIntent(intentPath);
    if (existingIntent) {
      if (
        existingIntent.captureKey !== request.captureKey ||
        existingIntent.repositoryId !== request.baseRevision.repositoryId ||
        existingIntent.storageRef !== storageRef
      ) {
        throw new Error("Candidate revision ID already belongs to another capture");
      }
      const identity = {
        repositoryId: existingIntent.repositoryId,
        objectFormat: existingIntent.objectFormat,
        commitOid: existingIntent.commitOid,
        treeOid: existingIntent.treeOid
      };
      return {
        revisionId: existingIntent.revisionId,
        storageRef: existingIntent.storageRef,
        ...identity,
        revisionDigest: sourceRevisionDigest(identity)
      };
    }
    const repository = this.repositoryPath(request.baseRevision.repositoryId);
    await validateGitTree(repository, request.baseRevision.commitOid);
    const temporary = mkdtempSync(join(this.#root, "captures", "candidate-"));
    try {
      const index = join(temporary, "index");
      const gitEnvironment = { GIT_INDEX_FILE: index };
      await git(
        ["--git-dir", repository, "read-tree", request.baseRevision.commitOid],
        undefined,
        gitEnvironment
      );
      await git(
        ["--git-dir", repository, `--work-tree=${workspace}`, "add", "--all", "--force", "--", "."],
        workspace,
        gitEnvironment
      );
      const treeOid = await git(["--git-dir", repository, "write-tree"], undefined, gitEnvironment);
      let commitOid = request.baseRevision.commitOid;
      if (treeOid !== request.baseRevision.treeOid) {
        const identityEnvironment = {
          ...gitEnvironment,
          GIT_AUTHOR_NAME: "ParallelPlay",
          GIT_AUTHOR_EMAIL: "parallelplay@local.invalid",
          GIT_COMMITTER_NAME: "ParallelPlay",
          GIT_COMMITTER_EMAIL: "parallelplay@local.invalid",
          GIT_AUTHOR_DATE: request.attemptStartedAt,
          GIT_COMMITTER_DATE: request.attemptStartedAt
        };
        commitOid = await git(
          [
            "--git-dir",
            repository,
            "commit-tree",
            treeOid,
            "-p",
            request.baseRevision.commitOid,
            "-m",
            `ParallelPlay candidate for attempt ${request.attemptId}`
          ],
          undefined,
          identityEnvironment
        );
      }
      const intent = persistCaptureIntent(intentPath, {
        schemaVersion: 1,
        revisionId: request.revisionId,
        repositoryId: request.baseRevision.repositoryId,
        captureKey: request.captureKey,
        objectFormat: request.baseRevision.objectFormat,
        commitOid,
        treeOid,
        storageRef
      });
      const current = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--verify",
        storageRef
      ]).catch(() => "");
      if (current && current !== intent.commitOid) {
        throw new Error("Candidate revision ref already points to another commit");
      }
      if (!current) {
        await git(["--git-dir", repository, "update-ref", storageRef, intent.commitOid]);
      }
      const identity = {
        repositoryId: intent.repositoryId,
        objectFormat: intent.objectFormat,
        commitOid: intent.commitOid,
        treeOid: intent.treeOid
      };
      return {
        revisionId: intent.revisionId,
        storageRef: intent.storageRef,
        ...identity,
        revisionDigest: sourceRevisionDigest(identity)
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async candidateDiff(
    baseRevision: SourceRevisionState,
    candidateRevision: SourceRevisionState
  ): Promise<CandidateDiffEntryV1[]> {
    if (baseRevision.repositoryId !== candidateRevision.repositoryId) {
      throw new Error("Candidate diff revisions belong to different repositories");
    }
    const [baseValid, candidateValid] = await Promise.all([
      this.verify(baseRevision),
      this.verify(candidateRevision)
    ]);
    if (!baseValid.valid || !candidateValid.valid) {
      throw new Error(
        baseValid.reason ?? candidateValid.reason ?? "Candidate diff revision is invalid"
      );
    }
    const repository = this.repositoryPath(baseRevision.repositoryId);
    const output = await gitRaw([
      "--git-dir",
      repository,
      "diff",
      "--no-renames",
      "--diff-filter=AMD",
      "--name-status",
      "-z",
      baseRevision.commitOid,
      candidateRevision.commitOid,
      "--"
    ]);
    const fields = output.split("\0").filter((value) => value.length > 0);
    if (fields.length % 2 !== 0) throw new Error("Git diff emitted malformed name-status data");
    const treeOid = async (commitOid: string, path: string): Promise<string | null> => {
      const entry = await gitRaw(["--git-dir", repository, "ls-tree", "-z", commitOid, "--", path]);
      if (!entry) return null;
      const tab = entry.indexOf("\t");
      const identity = (tab === -1 ? entry : entry.slice(0, tab)).split(" ");
      return identity[2] ?? null;
    };
    const entries: CandidateDiffEntryV1[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const status = fields[index];
      const path = fields[index + 1];
      if (!status || !path || !["A", "M", "D"].includes(status)) {
        throw new Error("Git diff emitted an unsupported change record");
      }
      entries.push({
        change: status === "A" ? "add" : status === "D" ? "delete" : "modify",
        path,
        oldOid: status === "A" ? null : await treeOid(baseRevision.commitOid, path),
        newOid: status === "D" ? null : await treeOid(candidateRevision.commitOid, path)
      });
    }
    return entries.sort(
      (left, right) =>
        left.path.localeCompare(right.path) || left.change.localeCompare(right.change)
    );
  }

  async initializeIntegrationRef(
    targetId: string,
    initialHead: SourceRevisionState
  ): Promise<string> {
    if (!UUID_PATTERN.test(targetId)) throw new Error("Integration target ID must be a UUID");
    const valid = await this.verify(initialHead);
    if (!valid.valid) throw new Error(valid.reason ?? "Initial integration head is invalid");
    const repository = this.repositoryPath(initialHead.repositoryId);
    const ref = `refs/parallelplay/integration/${targetId}`;
    const current = await git(["--git-dir", repository, "rev-parse", "--verify", ref]).catch(
      () => ""
    );
    if (current && current !== initialHead.commitOid) {
      throw new Error("Managed integration ref already has another head");
    }
    if (!current) {
      const zeroOid = "0".repeat(initialHead.objectFormat === "sha1" ? 40 : 64);
      await git(["--git-dir", repository, "update-ref", ref, initialHead.commitOid, zeroOid]);
    }
    return ref;
  }

  async readIntegrationHead(targetId: string, repositoryId: string): Promise<string> {
    if (!UUID_PATTERN.test(targetId)) throw new Error("Integration target ID must be a UUID");
    return git([
      "--git-dir",
      this.repositoryPath(repositoryId),
      "rev-parse",
      "--verify",
      `refs/parallelplay/integration/${targetId}^{commit}`
    ]);
  }

  async prepareIntegrationRevision(
    request: PrepareIntegrationRevisionRequest
  ): Promise<PreparedIntegrationRevision> {
    if (!UUID_PATTERN.test(request.revisionId)) throw new Error("Revision ID must be a UUID");
    if (!UUID_PATTERN.test(request.candidateId)) throw new Error("Candidate ID must be a UUID");
    if (
      request.baseRevision.repositoryId !== request.candidateRevision.repositoryId ||
      request.baseRevision.repositoryId !== request.expectedHeadRevision.repositoryId
    ) {
      throw new Error("Integration revisions belong to different repositories");
    }
    const repository = this.repositoryPath(request.baseRevision.repositoryId);
    await this.initializeIntegrationRef(request.targetId, request.expectedHeadRevision);
    const currentHead = await this.readIntegrationHead(
      request.targetId,
      request.baseRevision.repositoryId
    );
    if (currentHead !== request.expectedHeadRevision.commitOid) {
      throw new Error("Managed integration head changed before preparation");
    }
    if (request.baseRevision.commitOid === currentHead) {
      return {
        outcome: "prepared",
        revision: {
          revisionId: request.candidateRevision.revisionId,
          repositoryId: request.candidateRevision.repositoryId,
          objectFormat: request.candidateRevision.objectFormat,
          commitOid: request.candidateRevision.commitOid,
          treeOid: request.candidateRevision.treeOid,
          storageRef: request.candidateRevision.storageRef,
          revisionDigest: request.candidateRevision.revisionDigest
        }
      };
    }
    const mergeBaseOid = await git([
      "--git-dir",
      repository,
      "merge-base",
      currentHead,
      request.candidateRevision.commitOid
    ]);
    if (mergeBaseOid !== request.baseRevision.commitOid) {
      throw new Error("Candidate does not descend from its exact declared base");
    }
    const temporary = mkdtempSync(join(this.#root, "captures", "integration-"));
    try {
      const index = join(temporary, "index");
      const gitEnvironment = { GIT_INDEX_FILE: index, GIT_WORK_TREE: temporary };
      await git(
        [
          "--git-dir",
          repository,
          "read-tree",
          "-m",
          request.baseRevision.commitOid,
          currentHead,
          request.candidateRevision.commitOid
        ],
        undefined,
        gitEnvironment
      );
      await git(
        ["--git-dir", repository, "merge-index", "git-merge-one-file", "-a"],
        undefined,
        gitEnvironment
      ).catch(() => undefined);
      const unresolved = await git(
        ["--git-dir", repository, "ls-files", "-u", "-z"],
        undefined,
        gitEnvironment
      );
      const conflictPaths = [
        ...new Set(
          unresolved
            .split("\0")
            .filter(Boolean)
            .map((entry) => entry.slice(entry.indexOf("\t") + 1))
        )
      ].sort();
      if (conflictPaths.length > 0) {
        return { outcome: "conflicted", mergeBaseOid, paths: conflictPaths };
      }
      const treeOid = await git(["--git-dir", repository, "write-tree"], undefined, gitEnvironment);
      const identityEnvironment = {
        ...gitEnvironment,
        GIT_AUTHOR_NAME: "ParallelPlay",
        GIT_AUTHOR_EMAIL: "parallelplay@local.invalid",
        GIT_COMMITTER_NAME: "ParallelPlay",
        GIT_COMMITTER_EMAIL: "parallelplay@local.invalid",
        GIT_AUTHOR_DATE: request.preparedAt,
        GIT_COMMITTER_DATE: request.preparedAt
      };
      const commitOid = await git(
        [
          "--git-dir",
          repository,
          "commit-tree",
          treeOid,
          "-p",
          currentHead,
          "-m",
          `ParallelPlay rebased integration candidate ${request.candidateId}`
        ],
        undefined,
        identityEnvironment
      );
      const storageRef = `refs/parallelplay/revisions/${request.revisionId}`;
      const intentPath = join(this.#root, "captures", `${request.revisionId}.json`);
      const intent = persistCaptureIntent(intentPath, {
        schemaVersion: 1,
        revisionId: request.revisionId,
        repositoryId: request.baseRevision.repositoryId,
        captureKey: request.captureKey,
        objectFormat: request.baseRevision.objectFormat,
        commitOid,
        treeOid,
        storageRef
      });
      if (
        intent.captureKey !== request.captureKey ||
        intent.commitOid !== commitOid ||
        intent.treeOid !== treeOid
      ) {
        throw new Error("Prepared integration revision ID already has another identity");
      }
      const current = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--verify",
        storageRef
      ]).catch(() => "");
      if (current && current !== commitOid) {
        throw new Error("Prepared integration ref already points to another commit");
      }
      if (!current) await git(["--git-dir", repository, "update-ref", storageRef, commitOid]);
      const identity = {
        repositoryId: intent.repositoryId,
        objectFormat: intent.objectFormat,
        commitOid: intent.commitOid,
        treeOid: intent.treeOid
      };
      return {
        outcome: "prepared",
        revision: {
          revisionId: intent.revisionId,
          storageRef: intent.storageRef,
          ...identity,
          revisionDigest: sourceRevisionDigest(identity)
        }
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async promoteIntegrationRef(
    request: PromoteIntegrationRefRequest
  ): Promise<{ duplicate: boolean }> {
    if (!UUID_PATTERN.test(request.targetId))
      throw new Error("Integration target ID must be a UUID");
    const repository = this.repositoryPath(request.repositoryId);
    const ref = `refs/parallelplay/integration/${request.targetId}`;
    const current = await git(["--git-dir", repository, "rev-parse", "--verify", ref]);
    if (current === request.newCommitOid) return { duplicate: true };
    if (current !== request.expectedOldCommitOid) {
      throw new Error("Managed integration head changed before compare-and-swap promotion");
    }
    await git([
      "--git-dir",
      repository,
      "update-ref",
      ref,
      request.newCommitOid,
      request.expectedOldCommitOid
    ]);
    return { duplicate: false };
  }

  async checkout(revision: SourceRevisionState, destination: string): Promise<void> {
    await git([
      "--git-dir",
      this.repositoryPath(revision.repositoryId),
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.smudge=",
      "-c",
      "filter.lfs.required=false",
      "worktree",
      "add",
      "--detach",
      destination,
      revision.commitOid
    ]);
  }

  async removeCheckout(revision: SourceRevisionState, destination: string): Promise<void> {
    await git([
      "--git-dir",
      this.repositoryPath(revision.repositoryId),
      "worktree",
      "remove",
      "--force",
      destination
    ]).catch(() => undefined);
  }

  async status(checkout: string): Promise<string> {
    return git(["status", "--porcelain=v2", "--untracked-files=all"], checkout);
  }

  async verify(revision: SourceRevisionState): Promise<{ valid: boolean; reason: string | null }> {
    try {
      const repository = this.repositoryPath(revision.repositoryId);
      const objectFormat = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--show-object-format"
      ]);
      const commit = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--verify",
        `${revision.storageRef}^{commit}`
      ]);
      const tree = await git([
        "--git-dir",
        repository,
        "rev-parse",
        "--verify",
        `${revision.storageRef}^{tree}`
      ]);
      const digest = sourceRevisionDigest({
        repositoryId: revision.repositoryId,
        objectFormat: revision.objectFormat,
        commitOid: commit,
        treeOid: tree
      });
      return objectFormat === revision.objectFormat &&
        commit === revision.commitOid &&
        tree === revision.treeOid &&
        digest === revision.revisionDigest
        ? { valid: true, reason: null }
        : { valid: false, reason: "Managed Git identity does not match authoritative revision" };
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : "Git verification failed"
      };
    }
  }
}
