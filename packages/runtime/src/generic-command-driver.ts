import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DriverProtocolEventSchema as KernelDriverProtocolEventSchema,
  driverReceiptDigest
} from "@parallelplay/kernel";
import type { ArtifactStore } from "./artifact-store.js";
import {
  DriverEventBatchSchema,
  DriverArtifactSchema,
  DriverProtocolEventSchema,
  DriverReceiptSchema,
  type AgentDriver,
  type DriverArtifact,
  type DriverEventBatch,
  type DriverProtocolEvent,
  type DriverReceiptCollection,
  type DriverStartRequest,
  type GenericCommandLaunchRequest,
  type GenericCommandLaunchRequestV2
} from "./driver.js";
import type { CapturedRevision, GitRevisionStore, StoreStatus } from "./source-store.js";

const execFileAsync = promisify(execFile);
const MARKER = ".parallelplay-driver-store.json";
const FORMAT = { kind: "parallelplay-driver-store", schemaVersion: 1 } as const;
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 4096;
const MAX_ARTIFACTS = 256;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

export type GenericDriverFaultPoint =
  | "after-container-create"
  | "after-container-start"
  | "after-inspection"
  | "after-candidate-capture"
  | "after-receipt-persist";

export interface DockerPreflightStatus {
  ok: boolean;
  context: string | null;
  endpoint: string | null;
  serverVersion: string | null;
  operatingSystem: string | null;
  imageAvailable: boolean;
  failures: string[];
}

export type DriverReceiptBundle = DriverReceiptCollection;

interface LaunchIntent {
  schemaVersion: 1;
  effectKey: string;
  externalRunId: string;
  containerName: string;
  createdAt: string;
  request: GenericCommandLaunchRequest;
  contractDigest: string;
  cancellationReason: "operator_cancelled" | "timed_out" | "approval_required" | null;
  dockerArgs: string[];
}

interface DetailedInspection {
  batch: DriverEventBatch;
  allEvents: DriverProtocolEvent[];
  stdout: string;
  stderr: string;
  containerInspection: Record<string, unknown>;
  parseError: string | null;
}

export interface GenericCommandDriverOptions {
  root: string;
  sourceStore: GitRevisionStore;
  artifactStore: ArtifactStore;
  dockerBinary?: string;
  clock?: { now(): Date };
  faultInjector?: (point: GenericDriverFaultPoint) => void;
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate))
        throw new Error("Canonical JSON contains a non-finite number");
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate === "object") {
      const object = candidate as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(object)
          .sort()
          .map((key) => [key, normalize(object[key])])
      );
    }
    throw new Error("Canonical JSON contains an unsupported value");
  };
  return JSON.stringify(normalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isV2Request(
  request: GenericCommandLaunchRequest
): request is GenericCommandLaunchRequestV2 {
  return request.executionContract.protocolVersion === 2;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function atomicCreate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, path);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code !== "EEXIST") throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicReplace(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function storeStatus(root: string): StoreStatus {
  const marker = join(resolve(root), MARKER);
  if (!existsSync(marker)) return { exists: false, valid: false, schemaVersion: null };
  try {
    const value = parseJsonFile(marker) as Record<string, unknown>;
    return {
      exists: true,
      valid: value["kind"] === FORMAT.kind && value["schemaVersion"] === FORMAT.schemaVersion,
      schemaVersion: typeof value["schemaVersion"] === "number" ? value["schemaVersion"] : null
    };
  } catch {
    return { exists: true, valid: false, schemaVersion: null };
  }
}

export function getDriverStoreStatus(root: string): StoreStatus {
  return storeStatus(root);
}

export function initializeDriverStore(root: string): StoreStatus {
  const absolute = resolve(root);
  mkdirSync(join(absolute, "intents"), { recursive: true, mode: 0o700 });
  mkdirSync(join(absolute, "runs"), { recursive: true, mode: 0o700 });
  mkdirSync(join(absolute, "receipts"), { recursive: true, mode: 0o700 });
  const marker = join(absolute, MARKER);
  if (!existsSync(marker)) atomicCreate(marker, FORMAT);
  const status = storeStatus(absolute);
  if (!status.valid) throw new Error("Driver store has an unsupported format");
  return status;
}

async function command(
  executable: string,
  args: string[],
  maxBuffer = MAX_DIAGNOSTIC_BYTES
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(executable, args, {
    encoding: "utf8",
    maxBuffer,
    env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
}

function endpointFromContext(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function dockerPreflight(
  image?: string,
  dockerBinary = "docker"
): Promise<DockerPreflightStatus> {
  const failures: string[] = [];
  let context: string | null = null;
  let endpoint: string | null = null;
  let serverVersion: string | null = null;
  let operatingSystem: string | null = null;
  let imageAvailable = false;
  try {
    context = (await command(dockerBinary, ["context", "show"])).stdout.trim();
    const endpointJson = (
      await command(dockerBinary, [
        "context",
        "inspect",
        context,
        "--format",
        "{{json .Endpoints.docker.Host}}"
      ])
    ).stdout.trim();
    endpoint = endpointFromContext(JSON.parse(endpointJson) as unknown);
    if (!endpoint?.startsWith("unix://"))
      failures.push("Docker context is remote; only a local Unix socket is allowed");
    const info = JSON.parse(
      (await command(dockerBinary, ["info", "--format", "{{json .}}"])).stdout
    ) as Record<string, unknown>;
    serverVersion = typeof info["ServerVersion"] === "string" ? info["ServerVersion"] : null;
    operatingSystem = typeof info["OperatingSystem"] === "string" ? info["OperatingSystem"] : null;
    if (info["OSType"] !== "linux") failures.push("Docker daemon must run Linux containers");
    const securityOptions = Array.isArray(info["SecurityOptions"])
      ? info["SecurityOptions"].map(String)
      : [];
    if (securityOptions.length === 0) failures.push("Docker security features are unavailable");
    if (!securityOptions.some((value) => value.startsWith("name=seccomp"))) {
      failures.push("Docker seccomp support is required");
    }
    if (!securityOptions.some((value) => value.startsWith("name=cgroupns"))) {
      failures.push("Docker private cgroup namespaces are required");
    }
    if (image) {
      try {
        await command(dockerBinary, ["image", "inspect", image, "--format", "{{.Id}}"]);
        imageAvailable = true;
      } catch {
        failures.push(`Prepared sandbox image is unavailable: ${image}`);
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Docker daemon is unavailable");
  }
  return {
    ok: failures.length === 0,
    context,
    endpoint,
    serverVersion,
    operatingSystem,
    imageAvailable,
    failures
  };
}

export function parseDriverJsonl(stdout: string): DriverProtocolEvent[] {
  if (Buffer.byteLength(stdout) > MAX_PROTOCOL_BYTES)
    throw new Error("Driver protocol stream exceeds 4 MiB");
  if (stdout.length > 0 && !stdout.endsWith("\n")) {
    throw new Error("Driver protocol stream must end with a newline");
  }
  const lines = stdout.length === 0 ? [] : stdout.slice(0, -1).split("\n");
  if (lines.some((line) => line.length === 0))
    throw new Error("Driver protocol stream contains a blank line");
  if (lines.length > MAX_EVENTS) throw new Error("Driver protocol stream exceeds 4096 events");
  const events: DriverProtocolEvent[] = [];
  let expected = 1;
  let terminal = false;
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > 65_536)
      throw new Error(`Driver event ${String(index + 1)} exceeds 64 KiB`);
    let json: unknown;
    try {
      json = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Driver event ${String(index + 1)} is not valid JSON`);
    }
    const event = DriverProtocolEventSchema.parse(json);
    KernelDriverProtocolEventSchema.parse(event);
    if (event.sequence !== expected)
      throw new Error(`Expected driver event sequence ${String(expected)}`);
    if (expected === 1 && event.type !== "started") {
      throw new Error("Driver protocol stream must begin with started");
    }
    if (expected > 1 && event.type === "started") {
      throw new Error("Driver protocol stream contains multiple started events");
    }
    if (terminal) throw new Error("Driver emitted an event after terminal");
    terminal = event.type === "terminal";
    expected += 1;
    events.push(event);
  }
  return events;
}

export class GenericCommandDriver implements AgentDriver {
  readonly name = "generic-command" as const;
  readonly #root: string;
  readonly #sourceStore: GitRevisionStore;
  readonly #artifactStore: ArtifactStore;
  readonly #docker: string;
  readonly #clock: { now(): Date };
  readonly #faultInjector?: (point: GenericDriverFaultPoint) => void;

  constructor(options: GenericCommandDriverOptions) {
    if (!storeStatus(options.root).valid)
      throw new Error("Driver store must be initialized before use");
    this.#root = resolve(options.root);
    this.#sourceStore = options.sourceStore;
    this.#artifactStore = options.artifactStore;
    this.#docker = options.dockerBinary ?? "docker";
    this.#clock = options.clock ?? { now: () => new Date() };
    if (options.faultInjector) this.#faultInjector = options.faultInjector;
  }

  async start(effectKey: string, input: DriverStartRequest): Promise<string> {
    if (input.driver !== "generic-command") throw new Error("Generic driver requires a V2 request");
    const request = input;
    this.#validateRequest(request);
    const preflight = await dockerPreflight(request.executionContract.image, this.#docker);
    if (!preflight.ok)
      throw new Error(`Docker sandbox preflight failed: ${preflight.failures.join("; ")}`);
    const externalRunId = `docker:${effectKey}`;
    const containerName = `parallelplay-${effectKey}`;
    const intentPath = this.#intentPath(effectKey);
    const existing = existsSync(intentPath) ? (parseJsonFile(intentPath) as LaunchIntent) : null;
    if (existing) {
      if (existing.contractDigest !== digest(request))
        throw new Error("Effect key contract digest conflict");
      await this.#ensureStarted(existing);
      return existing.externalRunId;
    }
    const runRoot = this.#runRoot(effectKey);
    const workspace = join(runRoot, "workspace");
    const artifacts = join(runRoot, "artifacts");
    const scratch = join(runRoot, "scratch");
    const contextRoot = join(runRoot, "context");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    if (isV2Request(request)) {
      mkdirSync(contextRoot, { recursive: true, mode: 0o700 });
      const contextPath = join(contextRoot, "context.json");
      const bytes = canonicalJson(request.contextPacket);
      if (existsSync(contextPath)) {
        if (readFileSync(contextPath, "utf8") !== bytes) {
          throw new Error("Durable context packet bytes conflict");
        }
      } else {
        writeFileSync(contextPath, bytes, { flag: "wx", mode: 0o400 });
      }
      chmodSync(contextPath, 0o400);
    }
    await this.#sourceStore.materializePlain(request.baseRevision, workspace);
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    const mount = (source: string, target: string, readonly = false): string => {
      if (source.includes(",")) throw new Error("Sandbox paths cannot contain commas");
      return `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
    };
    const dockerArgs = [
      "create",
      "--name",
      containerName,
      "--label",
      `parallelplay.effect-key=${effectKey}`,
      "--label",
      `parallelplay.contract-digest=${request.executionContractDigest}`,
      ...(isV2Request(request)
        ? [`--label`, `parallelplay.context-digest=${request.contextPacketDigest}`]
        : []),
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--shm-size",
      "1m",
      "--pids-limit",
      String(request.capabilityManifest.pidsLimit),
      "--memory",
      String(request.capabilityManifest.memoryLimitBytes),
      "--cpus",
      String(request.capabilityManifest.cpuLimit),
      "--ulimit",
      "nofile=1024:1024",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=4m",
      "--log-opt",
      "max-file=1",
      "--user",
      `${String(uid)}:${String(gid)}`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "/usr/bin/env",
      "--mount",
      mount(workspace, "/workspace", request.capabilityManifest.workspace === "read_only"),
      "--mount",
      mount(artifacts, "/artifacts"),
      "--mount",
      mount(scratch, "/scratch"),
      ...(isV2Request(request) ? ["--mount", mount(contextRoot, "/context", true)] : []),
      request.executionContract.image,
      "-i",
      "HOME=/nonexistent",
      "TMPDIR=/scratch",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      ...(isV2Request(request) ? ["PARALLELPLAY_CONTEXT=/context/context.json"] : []),
      ...request.executionContract.argv
    ];
    const intent: LaunchIntent = {
      schemaVersion: 1,
      effectKey,
      externalRunId,
      containerName,
      createdAt: this.#clock.now().toISOString(),
      request,
      contractDigest: digest(request),
      cancellationReason: null,
      dockerArgs
    };
    atomicCreate(intentPath, intent);
    const durable = parseJsonFile(intentPath) as LaunchIntent;
    if (durable.contractDigest !== intent.contractDigest)
      throw new Error("Effect key contract digest conflict");
    await this.#ensureStarted(durable);
    return externalRunId;
  }

  async inspect(externalRunId: string, afterSequence: number): Promise<DriverEventBatch> {
    const intent = this.#intentForExternalRun(externalRunId);
    const bundlePath = this.#bundlePath(intent.request.attemptId);
    if (existsSync(bundlePath)) {
      const bundle = this.#parseBundle(bundlePath);
      if (afterSequence > bundle.receipt.eventCount) {
        throw new Error("Driver cursor exceeds the durable receipt event count");
      }
      return DriverEventBatchSchema.parse({
        afterSequence,
        events: [],
        status: bundle.receipt.outcome,
        exitCode: bundle.receipt.outcome === "succeeded" ? 0 : 1
      });
    }
    const detailed = await this.#inspectDetailed(externalRunId, afterSequence);
    this.#faultInjector?.("after-inspection");
    return DriverEventBatchSchema.parse(detailed.batch);
  }

  async cancel(
    effectKey: string,
    externalRunId: string,
    reason: "operator_cancelled" | "timed_out" | "approval_required"
  ): Promise<"cancelled"> {
    const intent = this.#intentForExternalRun(externalRunId);
    void effectKey;
    if (intent.cancellationReason === null) {
      intent.cancellationReason = reason;
      atomicReplace(this.#intentPath(intent.effectKey), intent);
    }
    await command(this.#docker, ["stop", "--time", "2", intent.containerName]).catch(
      () => undefined
    );
    return "cancelled";
  }

  async collectReceipt(externalRunId: string): Promise<DriverReceiptBundle> {
    const intent = this.#intentForExternalRun(externalRunId);
    const bundlePath = this.#bundlePath(intent.request.attemptId);
    if (existsSync(bundlePath)) {
      const durable = this.#parseBundle(bundlePath);
      await command(this.#docker, ["rm", "--force", intent.containerName]).catch(() => undefined);
      rmSync(this.#runRoot(intent.effectKey), { recursive: true, force: true });
      return durable;
    }
    const detailed = await this.#inspectDetailed(externalRunId, 0);
    if (detailed.batch.status === "running")
      throw new Error("Cannot collect a receipt for a running container");
    const terminal = detailed.allEvents.find((event) => event.type === "terminal");
    const approvals = detailed.allEvents
      .filter((event) => event.type === "approval.requested")
      .map((event) => ({
        requestId: event.requestId,
        capability: event.capability,
        reason: event.reason,
        sequence: event.sequence
      }));
    const capabilitiesUsed = [
      ...new Set(
        detailed.allEvents
          .filter((event) => event.type === "capability.used")
          .map((event) => event.capability)
      )
    ].sort();
    const usageEvents = detailed.allEvents.filter((event) => event.type === "usage");
    const usageV1 = {
      cpuMillis: Math.max(0, ...usageEvents.map((event) => event.cpuMillis)),
      memoryPeakBytes: Math.max(0, ...usageEvents.map((event) => event.memoryPeakBytes))
    };
    const declared = detailed.allEvents.filter((event) => event.type === "artifact.declared");
    const entries: DriverArtifact[] = [];
    entries.push(
      this.#artifactStore.put(
        "driver/protocol.jsonl",
        "driver.protocol",
        Buffer.from(detailed.stdout)
      ),
      this.#artifactStore.put("driver/stderr.log", "driver.stderr", Buffer.from(detailed.stderr)),
      this.#artifactStore.put(
        "driver/launch-contract.json",
        "driver.launch",
        Buffer.from(`${canonicalJson(intent.request)}\n`)
      ),
      this.#artifactStore.put(
        "driver/sandbox-manifest.json",
        "driver.sandbox",
        Buffer.from(
          `${canonicalJson({ dockerArgs: intent.dockerArgs, containerName: intent.containerName })}\n`
        )
      ),
      this.#artifactStore.put(
        "driver/container-inspection.json",
        "driver.inspect",
        Buffer.from(`${canonicalJson(detailed.containerInspection)}\n`)
      )
    );
    const diagnosticEntryCount = entries.length;
    let evidenceError: string | null = null;
    try {
      if (declared.length + entries.length + 1 > MAX_ARTIFACTS) {
        throw new Error("Declared artifact count exceeds the receipt limit");
      }
      const outputRoot = realpathSync(join(this.#runRoot(intent.effectKey), "artifacts"));
      const paths = new Set<string>();
      for (const artifact of declared) {
        if (paths.has(artifact.path))
          throw new Error(`Artifact declared more than once: ${artifact.path}`);
        paths.add(artifact.path);
        const path = resolve(outputRoot, artifact.path);
        if (!path.startsWith(`${outputRoot}/`))
          throw new Error("Declared artifact escapes output root");
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`Declared artifact is not a regular file: ${artifact.path}`);
        }
        entries.push(
          this.#artifactStore.put(`agent/${artifact.path}`, artifact.role, readFileSync(path))
        );
      }
      const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
      if (totalBytes > MAX_ARTIFACT_BYTES) {
        throw new Error("Driver artifact evidence exceeds 256 MiB");
      }
    } catch (error) {
      entries.splice(diagnosticEntryCount);
      evidenceError =
        error instanceof Error ? error.message : "Driver artifact evidence is invalid";
    }
    let candidateRevision: CapturedRevision | null = null;
    if (detailed.batch.status === "succeeded" && evidenceError === null) {
      try {
        candidateRevision = await this.#sourceStore.captureCandidate({
          revisionId: deterministicUuid(`${intent.request.attemptId}:candidate-revision`),
          captureKey: `${intent.request.attemptId}:candidate-revision`,
          baseRevision: intent.request.baseRevision,
          workspacePath: join(this.#runRoot(intent.effectKey), "workspace"),
          attemptStartedAt: intent.request.attemptStartedAt,
          attemptId: intent.request.attemptId
        });
      } catch (error) {
        evidenceError = error instanceof Error ? error.message : "Candidate capture is invalid";
      }
      if (candidateRevision) {
        this.#faultInjector?.("after-candidate-capture");
        entries.push(
          this.#artifactStore.put(
            "driver/candidate-diff.json",
            "driver.candidate",
            Buffer.from(
              `${canonicalJson({
                baseCommitOid: intent.request.baseRevision.commitOid,
                baseTreeOid: intent.request.baseRevision.treeOid,
                candidateCommitOid: candidateRevision.commitOid,
                candidateTreeOid: candidateRevision.treeOid
              })}\n`
            )
          )
        );
      }
    }
    if (evidenceError) {
      entries.push(
        this.#artifactStore.put(
          "driver/evidence-error.txt",
          "driver.error",
          Buffer.from(`${evidenceError}\n`)
        )
      );
    }
    const outcome = evidenceError ? ("protocol_invalid" as const) : detailed.batch.status;
    const receiptBase = {
      driver: "generic-command" as const,
      driverVersion: "2",
      runId: intent.request.runId,
      jobId: intent.request.jobId,
      attemptId: intent.request.attemptId,
      externalRunId,
      image: intent.request.executionContract.image,
      baseRevisionId: intent.request.baseRevisionId,
      baseRevisionDigest: intent.request.baseRevision.revisionDigest,
      candidateRevisionId: candidateRevision?.revisionId ?? null,
      candidateRevisionDigest: candidateRevision?.revisionDigest ?? null,
      executionContractDigest: intent.request.executionContractDigest,
      capabilityManifestDigest: intent.request.capabilityManifestDigest,
      eventStreamDigest: digest(detailed.allEvents),
      eventCount: detailed.allEvents.length,
      approvals,
      capabilitiesUsed,
      artifacts: entries,
      outcome,
      terminalReason:
        intent.cancellationReason ??
        evidenceError ??
        detailed.parseError ??
        (terminal?.type === "terminal" ? (terminal.detail ?? terminal.outcome) : outcome)
    };
    const receiptWithoutDigest = isV2Request(intent.request)
      ? {
          ...receiptBase,
          schemaVersion: 2 as const,
          protocolVersion: 2 as const,
          contextPacketId: intent.request.contextPacket.contextPacketId,
          contextPacketDigest: intent.request.contextPacketDigest,
          usage: {
            ...usageV1,
            monetaryCost: {
              status: "unavailable" as const,
              reason: "generic_local_docker_unpriced"
            }
          }
        }
      : {
          ...receiptBase,
          schemaVersion: 1 as const,
          protocolVersion: 1 as const,
          usage: usageV1
        };
    const provisional = { ...receiptWithoutDigest, receiptDigest: "0".repeat(64) };
    const receipt = DriverReceiptSchema.parse({
      ...receiptWithoutDigest,
      receiptDigest: driverReceiptDigest(provisional)
    });
    const bundle: DriverReceiptBundle = {
      schemaVersion: 1,
      driverReceiptId: deterministicUuid(`${intent.request.attemptId}:driver-receipt`),
      artifactManifestId: deterministicUuid(`${intent.request.attemptId}:agent-artifacts`),
      candidateRevision,
      receipt,
      entries,
      events: detailed.allEvents
    };
    atomicCreate(bundlePath, bundle);
    const durable = this.#parseBundle(bundlePath);
    this.#faultInjector?.("after-receipt-persist");
    await command(this.#docker, ["rm", "--force", intent.containerName]).catch(() => undefined);
    rmSync(this.#runRoot(intent.effectKey), { recursive: true, force: true });
    return durable;
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  #validateRequest(request: GenericCommandLaunchRequest): void {
    if (request.baseRevisionId !== request.baseRevision.revisionId)
      throw new Error("Base revision identity mismatch");
    if (digest(request.executionContract) !== request.executionContractDigest) {
      throw new Error("Execution contract digest mismatch");
    }
    if (digest(request.capabilityManifest) !== request.capabilityManifestDigest) {
      throw new Error("Capability manifest digest mismatch");
    }
    if (isV2Request(request)) {
      if (
        digest(request.contextPacket) !== request.contextPacketDigest ||
        request.contextPacket.contextPacketId.length === 0 ||
        request.executionContract.context.contextPacketId !==
          request.contextPacket.contextPacketId ||
        request.executionContract.context.contextPacketDigest !== request.contextPacketDigest ||
        request.capabilityManifest.context.contextPacketId !==
          request.contextPacket.contextPacketId ||
        request.capabilityManifest.context.contextPacketDigest !== request.contextPacketDigest
      ) {
        throw new Error("Context packet identity or digest mismatch");
      }
    }
  }

  async #ensureStarted(intent: LaunchIntent): Promise<void> {
    const inspect = await command(this.#docker, [
      "inspect",
      intent.containerName,
      "--format",
      "{{json .State}}"
    ]).catch(() => null);
    if (!inspect) {
      await command(this.#docker, intent.dockerArgs);
      this.#faultInjector?.("after-container-create");
    }
    const state = JSON.parse(
      (
        await command(this.#docker, [
          "inspect",
          intent.containerName,
          "--format",
          "{{json .State}}"
        ])
      ).stdout
    ) as Record<string, unknown>;
    if (state["Status"] === "created") {
      await command(this.#docker, ["start", intent.containerName]);
      this.#faultInjector?.("after-container-start");
    }
  }

  async #inspectDetailed(
    externalRunId: string,
    afterSequence: number
  ): Promise<DetailedInspection> {
    const intent = this.#intentForExternalRun(externalRunId);
    const logs = await command(this.#docker, ["logs", intent.containerName], MAX_PROTOCOL_BYTES);
    let allEvents: DriverProtocolEvent[] = [];
    let parseError: string | null = null;
    try {
      allEvents = parseDriverJsonl(logs.stdout);
      if (
        allEvents.some(
          (event) => event.schemaVersion !== intent.request.executionContract.protocolVersion
        )
      ) {
        throw new Error("Driver protocol version does not match the launch contract");
      }
    } catch (error) {
      parseError = error instanceof Error ? error.message : "Driver protocol is invalid";
    }
    let containerInspection = JSON.parse(
      (
        await command(this.#docker, [
          "inspect",
          intent.containerName,
          "--format",
          "{{json .State}}"
        ])
      ).stdout
    ) as Record<string, unknown>;
    const allowedCapabilities = new Set([
      "workspace.read",
      ...(intent.request.capabilityManifest.workspace === "read_write" ? ["workspace.write"] : []),
      "artifact.write",
      "scratch.write"
    ]);
    const violation = allEvents.find(
      (event) => event.type === "capability.used" && !allowedCapabilities.has(event.capability)
    );
    const approval = allEvents.find((event) => event.type === "approval.requested");
    const terminal = allEvents.find((event) => event.type === "terminal");
    let status: DriverEventBatch["status"] = "running";
    if (intent.cancellationReason) status = intent.cancellationReason;
    else if (parseError) status = "protocol_invalid";
    else if (violation) status = "capability_violation";
    else if (approval) status = "approval_required";
    else if (terminal?.type === "terminal") status = terminal.outcome;
    const workerTerminalWhileRunning =
      terminal?.type === "terminal" &&
      containerInspection["Running"] === true &&
      !intent.cancellationReason &&
      !parseError &&
      !violation &&
      !approval;
    if (workerTerminalWhileRunning) status = "running";
    const mustStop =
      status !== "running" &&
      containerInspection["Running"] === true &&
      (!terminal ||
        intent.cancellationReason !== null ||
        parseError !== null ||
        violation !== undefined ||
        approval !== undefined);
    if (mustStop) {
      await command(this.#docker, ["stop", "--time", "2", intent.containerName]).catch(
        () => undefined
      );
      containerInspection = JSON.parse(
        (
          await command(this.#docker, [
            "inspect",
            intent.containerName,
            "--format",
            "{{json .State}}"
          ])
        ).stdout
      ) as Record<string, unknown>;
    }
    const running = containerInspection["Running"] === true;
    const exitCode =
      typeof containerInspection["ExitCode"] === "number" ? containerInspection["ExitCode"] : null;
    if (!running && status === "running") status = "protocol_invalid";
    if (status === "succeeded" && exitCode !== 0) status = "protocol_invalid";
    const events = allEvents.filter(
      (event) =>
        event.sequence > afterSequence && !(workerTerminalWhileRunning && event.type === "terminal")
    );
    return {
      batch: { afterSequence, events, status, exitCode: running ? null : exitCode },
      allEvents,
      stdout: logs.stdout,
      stderr: logs.stderr,
      containerInspection,
      parseError
    };
  }

  #intentForExternalRun(externalRunId: string): LaunchIntent {
    if (!externalRunId.startsWith("docker:")) throw new Error("Invalid generic external run ID");
    const effectKey = externalRunId.slice("docker:".length);
    const path = this.#intentPath(effectKey);
    if (!existsSync(path)) throw new Error(`Unknown generic external run: ${externalRunId}`);
    const intent = parseJsonFile(path) as LaunchIntent;
    if (intent.externalRunId !== externalRunId) throw new Error("Driver launch intent is corrupt");
    return intent;
  }

  #parseBundle(path: string): DriverReceiptBundle {
    const bundle = parseJsonFile(path) as Partial<DriverReceiptBundle>;
    if (
      bundle.schemaVersion !== 1 ||
      !Array.isArray(bundle.entries) ||
      !Array.isArray(bundle.events) ||
      typeof bundle.driverReceiptId !== "string" ||
      typeof bundle.artifactManifestId !== "string"
    ) {
      throw new Error("Driver receipt bundle is corrupt or unsupported");
    }
    const receipt = DriverReceiptSchema.parse(bundle.receipt);
    const events = bundle.events.map((event) => DriverProtocolEventSchema.parse(event));
    const entries = bundle.entries.map((entry) => DriverArtifactSchema.parse(entry));
    const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path));
    const sortedReceiptEntries = [...receipt.artifacts].sort((left, right) =>
      left.path.localeCompare(right.path)
    );
    if (
      receipt.receiptDigest !== driverReceiptDigest(receipt) ||
      receipt.eventCount !== events.length ||
      receipt.eventStreamDigest !== digest(events) ||
      digest(sortedEntries) !== digest(sortedReceiptEntries) ||
      bundle.driverReceiptId !== deterministicUuid(`${receipt.attemptId}:driver-receipt`) ||
      bundle.artifactManifestId !== deterministicUuid(`${receipt.attemptId}:agent-artifacts`) ||
      bundle.candidateRevision?.revisionId !== (receipt.candidateRevisionId ?? undefined) ||
      bundle.candidateRevision?.revisionDigest !== (receipt.candidateRevisionDigest ?? undefined)
    ) {
      throw new Error("Driver receipt bundle integrity check failed");
    }
    return {
      schemaVersion: 1,
      driverReceiptId: bundle.driverReceiptId,
      artifactManifestId: bundle.artifactManifestId,
      candidateRevision: bundle.candidateRevision ?? null,
      receipt,
      entries,
      events
    };
  }

  #intentPath(effectKey: string): string {
    return join(this.#root, "intents", `${effectKey}.json`);
  }

  #runRoot(effectKey: string): string {
    return join(this.#root, "runs", effectKey);
  }

  #bundlePath(attemptId: string): string {
    return join(this.#root, "receipts", `${attemptId}.json`);
  }
}
