import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DriverCancelV1Schema,
  DriverEventBatchV1Schema,
  DriverInspectV1Schema,
  DriverLaunchV1Schema,
  DriverReceiptV1Schema,
  DriverResumeV1Schema,
  DriverSessionV1Schema,
  ExtensionManifestV1Schema,
  RelativePathSchema,
  type AgentDriverV1,
  type DriverCancelV1,
  type DriverEventBatchV1,
  type DriverLaunchV1,
  type DriverProtocolEventV1,
  type DriverReceiptV1,
  type DriverResumeV1,
  type DriverSessionV1,
  type ExtensionManifestV1
} from "@parallelplay/contracts";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const DigestPinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);
const RawEventSchema = z.looseObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().positive(),
  type: z.string().min(1)
});
const DockerStateSchema = z.looseObject({
  Running: z.boolean(),
  ExitCode: z.number().int()
});
const ForcedTerminalSchema = z.strictObject({
  outcome: z.enum([
    "failed",
    "approval_required",
    "capability_violation",
    "protocol_invalid",
    "operator_cancelled",
    "timed_out"
  ]),
  reason: z.string().min(1).max(1000)
});
const StoredStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  request: DriverLaunchV1Schema,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  session: DriverSessionV1Schema,
  containerName: z.string().regex(/^pp-generic-[a-z0-9-]+$/),
  image: DigestPinnedImage,
  command: z.array(z.string().min(1).max(10_000)).min(1).max(128),
  workspace: z.string().min(1),
  artifacts: z.string().min(1),
  scratch: z.string().min(1),
  context: z.string().min(1),
  forcedTerminal: ForcedTerminalSchema.nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable()
});
type StoredState = z.infer<typeof StoredStateSchema>;

export interface GenericCommandAgentDriverOptions {
  manifest: ExtensionManifestV1;
  image: string;
  command: readonly string[];
  workspaceRoot: string;
  sessionRoot: string;
  dockerBinary?: string;
  clock?: { now(): Date };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function eventTime(startedAt: string, sequence: number): string {
  return new Date(new Date(startedAt).getTime() + sequence).toISOString();
}

export function buildGenericCommandDockerArgs(options: {
  name: string;
  image: string;
  command: readonly string[];
  workspace: string;
  artifacts: string;
  scratch: string;
  context: string;
  capabilityManifest: DriverLaunchV1["capabilityManifest"];
}): string[] {
  const capability = options.capabilityManifest;
  const uid = process.getuid?.() ?? 65_534;
  const gid = process.getgid?.() ?? 65_534;
  return [
    "create",
    "--name",
    options.name,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(capability.resources.pidsLimit),
    "--memory",
    String(capability.resources.memoryLimitBytes),
    "--cpus",
    String(capability.resources.cpuLimit),
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,src=${resolve(options.workspace)},dst=/workspace${capability.workspace === "read_only" ? ",readonly" : ""}`,
    "--mount",
    `type=bind,src=${resolve(options.artifacts)},dst=/artifacts`,
    "--mount",
    `type=bind,src=${resolve(options.scratch)},dst=/scratch`,
    "--mount",
    `type=bind,src=${resolve(options.context)},dst=/context,readonly`,
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/scratch",
    "--env",
    "LANG=C",
    "--env",
    "LC_ALL=C",
    "--env",
    "PARALLELPLAY_CONTEXT=/context/request.json",
    DigestPinnedImage.parse(options.image),
    ...options.command
  ];
}

export class GenericCommandAgentDriver implements AgentDriverV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #image: string;
  readonly #command: string[];
  readonly #workspaceRoot: string;
  readonly #sessionRoot: string;
  readonly #docker: string;
  readonly #clock: { now(): Date };
  readonly #states = new Map<string, StoredState>();

  constructor(options: GenericCommandAgentDriverOptions) {
    const manifest = ExtensionManifestV1Schema.parse(options.manifest);
    if (
      manifest.id !== "generic-command" ||
      manifest.kind !== "driver" ||
      manifest.contract.name !== "agent-driver-v1"
    ) {
      throw new Error("Generic command driver requires a generic-command agent-driver-v1 manifest");
    }
    this.manifest = manifest;
    this.#image = DigestPinnedImage.parse(options.image);
    this.#command = z.array(z.string().min(1).max(10_000)).min(1).max(128).parse(options.command);
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#sessionRoot = resolve(options.sessionRoot);
    this.#docker = options.dockerBinary ?? "docker";
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async start(rawRequest: DriverLaunchV1): Promise<DriverSessionV1> {
    const request = DriverLaunchV1Schema.parse(rawRequest);
    if (
      request.requestedModel !== null ||
      request.capabilityManifest.network.length !== 0 ||
      request.capabilityManifest.secretHandles.length !== 0 ||
      digest(request.capabilityManifest) !== request.capabilityManifestDigest
    ) {
      throw new Error("Generic command launch must be keyless, offline, and capability-bound");
    }
    const existing = await this.#stateForEffect(request.effectKey);
    if (existing) {
      if (existing.requestDigest !== digest(request)) {
        throw new Error("Generic command effect key was reused with a different launch request");
      }
      this.#states.set(existing.session.sessionId, existing);
      return existing.session;
    }
    const sessionId = randomUUID();
    const startedAt = this.#clock.now().toISOString();
    const checkpointDigest = digest({
      driver: this.manifest.artifact.sha256,
      image: this.#image,
      request: digest(request),
      sessionId
    });
    const session = DriverSessionV1Schema.parse({
      schemaVersion: 1,
      driverId: this.manifest.id,
      driverVersion: this.manifest.extensionVersion,
      sessionId,
      externalRunId: `generic:${sessionId}`,
      startedAt,
      checkpointDigest
    });
    const workspace = resolve(this.#workspaceRoot, request.runId);
    const root = resolve(this.#sessionRoot, sessionId);
    const artifacts = join(root, "artifacts");
    const scratch = join(root, "scratch");
    const context = join(root, "context");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(artifacts, { recursive: true, mode: 0o700 }),
      mkdir(scratch, { recursive: true, mode: 0o700 }),
      mkdir(context, { recursive: true, mode: 0o700 })
    ]);
    await writeFile(join(context, "request.json"), `${canonical(request)}\n`, { mode: 0o400 });
    const containerName = `pp-generic-${sessionId.replaceAll("-", "")}`;
    const state = StoredStateSchema.parse({
      schemaVersion: 1,
      request,
      requestDigest: digest(request),
      session,
      containerName,
      image: this.#image,
      command: this.#command,
      workspace,
      artifacts,
      scratch,
      context,
      forcedTerminal: null,
      completedAt: null
    });
    await this.#dockerCommand(
      buildGenericCommandDockerArgs({
        name: containerName,
        image: this.#image,
        command: this.#command,
        workspace,
        artifacts,
        scratch,
        context,
        capabilityManifest: request.capabilityManifest
      })
    );
    try {
      await this.#persist(state);
      await this.#dockerCommand(["start", containerName]);
    } catch (error) {
      await this.#dockerCommand(["rm", "--force", containerName]).catch(() => undefined);
      throw error;
    }
    this.#states.set(sessionId, state);
    return session;
  }

  async resume(rawRequest: DriverResumeV1): Promise<DriverSessionV1> {
    const request = DriverResumeV1Schema.parse(rawRequest);
    const state = await this.#state(request.sessionId);
    if (
      state.forcedTerminal !== null ||
      state.session.checkpointDigest !== request.checkpointDigest ||
      state.request.contextDigest !== request.contextDigest ||
      state.request.executionContractDigest !== request.executionContractDigest ||
      state.request.capabilityManifestDigest !== request.capabilityManifestDigest ||
      state.image !== this.#image ||
      state.command.join("\0") !== this.#command.join("\0")
    ) {
      throw new Error("Generic command resume binding does not match a nonterminal session");
    }
    const batch = await this.inspect({
      schemaVersion: 1,
      sessionId: request.sessionId,
      afterSequence: 0
    });
    if (batch.status !== "running") throw new Error("Generic command session is terminal");
    return state.session;
  }

  async inspect(rawRequest: Parameters<AgentDriverV1["inspect"]>[0]): Promise<DriverEventBatchV1> {
    const request = DriverInspectV1Schema.parse(rawRequest);
    const state = await this.#state(request.sessionId);
    await this.#enforceTimeout(state);
    const events = await this.#events(state);
    if (request.afterSequence > events.length) throw new Error("Generic command cursor is invalid");
    const terminal = events.find((event) => event.type === "terminal");
    const status = terminal?.type === "terminal" ? terminal.outcome : "running";
    return DriverEventBatchV1Schema.parse({
      schemaVersion: 1,
      afterSequence: request.afterSequence,
      events: events.filter((event) => event.sequence > request.afterSequence),
      status
    });
  }

  async cancel(
    rawRequest: DriverCancelV1
  ): Promise<{ status: "cancelled"; receiptDigest: string }> {
    const request = DriverCancelV1Schema.parse(rawRequest);
    const state = await this.#state(request.sessionId);
    if (!state.forcedTerminal) {
      state.forcedTerminal = {
        outcome: request.reason,
        reason: request.reason.replaceAll("_", " ")
      };
      state.completedAt = this.#clock.now().toISOString();
      await this.#dockerCommand(["stop", "--time", "2", state.containerName]).catch(
        () => undefined
      );
      await this.#persist(state);
    }
    return {
      status: "cancelled",
      receiptDigest: digest({ effectKey: request.effectKey, outcome: state.forcedTerminal.outcome })
    };
  }

  async collectReceipt(sessionId: string): Promise<DriverReceiptV1> {
    const state = await this.#state(sessionId);
    const events = await this.#events(state);
    const terminal = events.find((event) => event.type === "terminal");
    if (terminal?.type !== "terminal") throw new Error("Generic command receipt is not terminal");
    if (!state.completedAt) {
      state.completedAt = this.#clock.now().toISOString();
      await this.#persist(state);
    }
    const logs = await this.#logs(state.containerName);
    return DriverReceiptV1Schema.parse({
      schemaVersion: 1,
      driverId: this.manifest.id,
      driverVersion: this.manifest.extensionVersion,
      sdkVersion: null,
      sessionId: state.session.sessionId,
      externalRunId: state.session.externalRunId,
      requestedModel: null,
      observedModels: [],
      contextDigest: state.request.contextDigest,
      executionContractDigest: state.request.executionContractDigest,
      capabilityManifestDigest: state.request.capabilityManifestDigest,
      eventStreamDigest: digest(events),
      rawStreamDigest: createHash("sha256").update(logs).digest("hex"),
      checkpointDigest: state.session.checkpointDigest,
      outcome: terminal.outcome,
      terminalReason: terminal.reason,
      completedAt: state.completedAt
    });
  }

  async close(): Promise<void> {
    for (const state of this.#states.values()) {
      if (!state.forcedTerminal) {
        await this.cancel({
          schemaVersion: 1,
          effectKey: `close:${state.request.effectKey}`,
          sessionId: state.session.sessionId,
          reason: "operator_cancelled"
        });
      }
      await this.#dockerCommand(["rm", "--force", state.containerName]).catch(() => undefined);
    }
    this.#states.clear();
  }

  async #events(state: StoredState, settleAttempt = 0): Promise<DriverProtocolEventV1[]> {
    const logs = await this.#logs(state.containerName);
    const lines = logs.split("\n").filter(Boolean);
    const events: DriverProtocolEventV1[] = [];
    let forced = state.forcedTerminal;
    for (const [index, line] of lines.entries()) {
      if (Buffer.byteLength(line) > 1024 * 1024) {
        forced = { outcome: "protocol_invalid", reason: "Driver event exceeded the size limit" };
        break;
      }
      let raw: z.infer<typeof RawEventSchema>;
      try {
        raw = RawEventSchema.parse(JSON.parse(line) as unknown);
      } catch {
        forced = {
          outcome: "protocol_invalid",
          reason: "Driver emitted malformed structured output"
        };
        break;
      }
      if (raw.sequence !== index + 1) {
        forced = { outcome: "protocol_invalid", reason: "Driver event ordering is invalid" };
        break;
      }
      const occurredAt = eventTime(state.session.startedAt, raw.sequence);
      if (raw.type === "started") {
        events.push({ schemaVersion: 1, sequence: raw.sequence, occurredAt, type: "started" });
      } else if (raw.type === "capability.used") {
        const value = z.looseObject({ capability: z.string().min(1) }).parse(raw);
        const allowed = new Set([
          ...(state.request.capabilityManifest.workspace === "read_write"
            ? ["workspace.write"]
            : []),
          "artifact.write"
        ]);
        if (!allowed.has(value.capability)) {
          forced = {
            outcome: "capability_violation",
            reason: "Driver used an undeclared capability"
          };
          break;
        }
        events.push({
          schemaVersion: 1,
          sequence: raw.sequence,
          occurredAt,
          type: "capability.used",
          capability: value.capability
        });
      } else if (raw.type === "artifact.declared") {
        const value = z
          .looseObject({ path: RelativePathSchema, role: z.string().min(1) })
          .parse(raw);
        const artifactPath = resolve(state.artifacts, value.path);
        if (!artifactPath.startsWith(`${resolve(state.artifacts)}/`)) {
          forced = { outcome: "protocol_invalid", reason: "Artifact path escaped its root" };
          break;
        }
        const bytes = await readFile(artifactPath);
        events.push({
          schemaVersion: 1,
          sequence: raw.sequence,
          occurredAt,
          type: "artifact.declared",
          path: value.path,
          role: value.role,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex")
        });
      } else if (raw.type === "usage") {
        events.push({
          schemaVersion: 1,
          sequence: raw.sequence,
          occurredAt,
          type: "usage",
          provider: "local",
          requestedModel: null,
          observedModel: null,
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          monetaryCost: { status: "unavailable", reason: "Local command has no token pricing" }
        });
      } else if (raw.type === "approval.requested") {
        const value = z
          .looseObject({
            requestId: z.uuid(),
            capability: z.string().min(1),
            reason: z.string().min(1).max(1000)
          })
          .parse(raw);
        events.push({
          schemaVersion: 1,
          sequence: raw.sequence,
          occurredAt,
          type: "approval.requested",
          requestId: value.requestId,
          capability: value.capability,
          reason: value.reason
        });
        forced = { outcome: "approval_required", reason: "Driver requested additional authority" };
        break;
      } else if (raw.type === "terminal") {
        const value = z
          .looseObject({ outcome: z.enum(["succeeded", "failed"]), detail: z.string().optional() })
          .parse(raw);
        events.push({
          schemaVersion: 1,
          sequence: raw.sequence,
          occurredAt,
          type: "terminal",
          outcome: value.outcome,
          reason: value.detail?.slice(0, 1000) ?? `Generic command ${value.outcome}`
        });
        break;
      } else {
        forced = { outcome: "protocol_invalid", reason: "Driver emitted an unknown event type" };
        break;
      }
    }
    if (!events.some((event) => event.type === "terminal")) {
      const docker = await this.#containerState(state.containerName);
      if (!docker.Running && !forced) {
        if (settleAttempt < 3) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
          return this.#events(state, settleAttempt + 1);
        }
        forced = { outcome: "protocol_invalid", reason: "Driver exited without a terminal event" };
      }
      if (forced) {
        await this.#forceTerminal(state, forced);
        events.push({
          schemaVersion: 1,
          sequence: events.length + 1,
          occurredAt: eventTime(state.session.startedAt, events.length + 1),
          type: "terminal",
          outcome: forced.outcome,
          reason: forced.reason
        });
      }
    } else if (!state.completedAt) {
      state.completedAt = this.#clock.now().toISOString();
      await this.#persist(state);
    }
    return events;
  }

  async #forceTerminal(
    state: StoredState,
    terminal: z.infer<typeof ForcedTerminalSchema>
  ): Promise<void> {
    state.forcedTerminal = ForcedTerminalSchema.parse(terminal);
    state.completedAt ??= this.#clock.now().toISOString();
    await this.#dockerCommand(["stop", "--time", "2", state.containerName]).catch(() => undefined);
    await this.#persist(state);
  }

  async #enforceTimeout(state: StoredState): Promise<void> {
    if (state.forcedTerminal) return;
    const deadline =
      new Date(state.session.startedAt).getTime() +
      state.request.capabilityManifest.resources.wallTimeMs;
    if (this.#clock.now().getTime() >= deadline) {
      await this.#forceTerminal(state, {
        outcome: "timed_out",
        reason: "Generic command wall time expired"
      });
    }
  }

  async #logs(containerName: string): Promise<string> {
    try {
      const result = await execFileAsync(this.#docker, ["logs", containerName], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
      });
      return result.stdout;
    } catch (error) {
      const failure = error as { stdout?: string };
      if (typeof failure.stdout === "string") return failure.stdout;
      throw error;
    }
  }

  async #containerState(containerName: string): Promise<z.infer<typeof DockerStateSchema>> {
    const result = await execFileAsync(
      this.#docker,
      ["inspect", "--format", "{{json .State}}", containerName],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
      }
    );
    return DockerStateSchema.parse(JSON.parse(result.stdout) as unknown);
  }

  async #dockerCommand(args: string[]): Promise<void> {
    await execFileAsync(this.#docker, args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
    });
  }

  async #state(sessionId: string): Promise<StoredState> {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    const state = StoredStateSchema.parse(
      JSON.parse(await readFile(this.#sessionPath(sessionId), "utf8")) as unknown
    );
    if (state.image !== this.#image || state.command.join("\0") !== this.#command.join("\0")) {
      throw new Error("Stored generic command session does not match this driver artifact");
    }
    this.#states.set(sessionId, state);
    return state;
  }

  async #stateForEffect(effectKey: string): Promise<StoredState | null> {
    try {
      const index = z
        .strictObject({ sessionId: z.uuid(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(JSON.parse(await readFile(this.#effectPath(effectKey), "utf8")) as unknown);
      return await this.#state(index.sessionId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async #persist(state: StoredState): Promise<void> {
    const parsed = StoredStateSchema.parse(state);
    await mkdir(resolve(this.#sessionRoot, "sessions"), { recursive: true, mode: 0o700 });
    await mkdir(resolve(this.#sessionRoot, "effects"), { recursive: true, mode: 0o700 });
    await this.#atomicWrite(this.#sessionPath(parsed.session.sessionId), parsed);
    await this.#atomicWrite(this.#effectPath(parsed.request.effectKey), {
      sessionId: parsed.session.sessionId,
      requestDigest: parsed.requestDigest
    });
  }

  async #atomicWrite(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${canonical(value)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  #sessionPath(sessionId: string): string {
    return join(resolve(this.#sessionRoot, "sessions"), `${digest(sessionId)}.json`);
  }

  #effectPath(effectKey: string): string {
    return join(resolve(this.#sessionRoot, "effects"), `${digest(effectKey)}.json`);
  }
}
