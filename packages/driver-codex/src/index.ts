import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import {
  DriverCancelV1Schema,
  DriverEventBatchV1Schema,
  DriverInspectV1Schema,
  DriverLaunchV1Schema,
  DriverReceiptV1Schema,
  DriverResumeV1Schema,
  DriverSessionV1Schema,
  ExtensionManifestV1Schema,
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

const SDK_VERSION = "0.149.0";
const MAX_PROVIDER_EVENT_BYTES = 2 * 1024 * 1024;
const ProviderTextSchema = z.string().max(MAX_PROVIDER_EVENT_BYTES);
const UsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative(),
  cache_write_input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  reasoning_output_tokens: z.number().int().nonnegative()
});
const ThreadItemSchema = z.discriminatedUnion("type", [
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("agent_message"),
    text: ProviderTextSchema
  }),
  z.looseObject({ id: z.string().min(1), type: z.literal("reasoning"), text: ProviderTextSchema }),
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("command_execution"),
    command: ProviderTextSchema,
    aggregated_output: ProviderTextSchema,
    exit_code: z.number().int().optional(),
    status: z.enum(["in_progress", "completed", "failed"])
  }),
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("file_change"),
    changes: z.array(
      z.strictObject({ path: ProviderTextSchema, kind: z.enum(["add", "delete", "update"]) })
    ),
    status: z.enum(["completed", "failed"])
  }),
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("mcp_tool_call"),
    server: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown(),
    status: z.enum(["in_progress", "completed", "failed"])
  }),
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("web_search"),
    query: ProviderTextSchema
  }),
  z.looseObject({
    id: z.string().min(1),
    type: z.literal("todo_list"),
    items: z.array(z.strictObject({ text: ProviderTextSchema, completed: z.boolean() }))
  }),
  z.looseObject({ id: z.string().min(1), type: z.literal("error"), message: ProviderTextSchema })
]);
const CodexEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("thread.started"), thread_id: z.string().min(1) }),
  z.strictObject({ type: z.literal("turn.started") }),
  z.strictObject({ type: z.literal("turn.completed"), usage: UsageSchema }),
  z.strictObject({
    type: z.literal("turn.failed"),
    error: z.strictObject({ message: ProviderTextSchema })
  }),
  z.strictObject({ type: z.literal("item.started"), item: ThreadItemSchema }),
  z.strictObject({ type: z.literal("item.updated"), item: ThreadItemSchema }),
  z.strictObject({ type: z.literal("item.completed"), item: ThreadItemSchema }),
  z.strictObject({ type: z.literal("error"), message: ProviderTextSchema })
]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function parseProviderEvent(raw: unknown): z.infer<typeof CodexEventSchema> {
  const encoded = canonical(raw);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_EVENT_BYTES) {
    throw new Error("Codex provider event exceeded the validated size limit");
  }
  return CodexEventSchema.parse(raw);
}

interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ events: AsyncIterable<unknown> }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export interface CodexSdkDriverOptions {
  manifest: ExtensionManifestV1;
  brokerBaseUrl: string;
  brokerToken: string;
  workspace?: string;
  sessionDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  clock?: { now(): Date };
  clientFactory?: () => CodexClientLike;
}

interface StoredSession {
  schemaVersion: 1;
  session: DriverSessionV1;
  providerSessionId: string | null;
  prompt: string;
  launch: DriverLaunchV1;
  events: DriverProtocolEventV1[];
  rawStreamDigest: string;
  rawEventCount: number;
  seenRawEventDigests: string[];
  baselineFiles: Record<string, string>;
  status: DriverEventBatchV1["status"];
  terminalReason: string | null;
  completedAt: string | null;
}

interface LiveSession extends StoredSession {
  abortController: AbortController | null;
  timeout: NodeJS.Timeout | null;
  persistChain: Promise<void>;
}

type PendingDriverEvent = DriverProtocolEventV1 extends infer Event
  ? Event extends DriverProtocolEventV1
    ? Omit<Event, "schemaVersion" | "sequence" | "occurredAt">
    : never
  : never;

export class CodexSdkDriver implements AgentDriverV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #workspace: string;
  readonly #sessionDirectory: string;
  readonly #clock: { now(): Date };
  readonly #clientFactory: () => CodexClientLike;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(options: CodexSdkDriverOptions) {
    const environment = options.environment ?? process.env;
    if (environment["PARALLELPLAY_OCI_BOUNDARY"] !== "1") {
      throw new Error("Codex SDK driver refuses to run outside the ParallelPlay OCI boundary");
    }
    const manifest = ExtensionManifestV1Schema.parse(options.manifest);
    if (
      manifest.id !== "codex-sdk" ||
      manifest.kind !== "driver" ||
      manifest.contract.name !== "agent-driver-v1" ||
      manifest.artifact.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
      !manifest.artifact.reference.endsWith(`@sha256:${manifest.artifact.sha256}`)
    ) {
      throw new Error("Codex SDK driver requires a digest-pinned codex-sdk manifest");
    }
    this.manifest = manifest;
    this.#workspace = options.workspace ?? "/workspace";
    this.#sessionDirectory = options.sessionDirectory ?? "/session/codex";
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#clientFactory =
      options.clientFactory ??
      (() =>
        new Codex({
          baseUrl: options.brokerBaseUrl,
          apiKey: options.brokerToken,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/session",
            LANG: "C",
            LC_ALL: "C",
            PARALLELPLAY_OCI_BOUNDARY: "1"
          }
        }));
  }

  async start(rawRequest: DriverLaunchV1): Promise<DriverSessionV1> {
    const request = DriverLaunchV1Schema.parse(rawRequest);
    const baselineFiles = await this.#workspaceFiles();
    const sessionId = randomUUID();
    const now = this.#clock.now().toISOString();
    const session = DriverSessionV1Schema.parse({
      schemaVersion: 1,
      driverId: this.manifest.id,
      driverVersion: this.manifest.extensionVersion,
      sessionId,
      externalRunId: `codex:${sessionId}`,
      startedAt: now,
      checkpointDigest: null
    });
    const state: LiveSession = {
      schemaVersion: 1,
      session,
      providerSessionId: null,
      prompt: request.prompt,
      launch: request,
      events: [{ schemaVersion: 1, sequence: 1, occurredAt: now, type: "started" }],
      rawStreamDigest: sha256(""),
      rawEventCount: 0,
      seenRawEventDigests: [],
      baselineFiles,
      status: "running",
      terminalReason: null,
      completedAt: null,
      abortController: new AbortController(),
      timeout: null,
      persistChain: Promise.resolve()
    };
    this.#sessions.set(sessionId, state);
    await this.#persist(state);
    const thread = this.#clientFactory().startThread(this.#threadOptions(request));
    this.#armTimeout(state);
    void this.#consume(state, thread, request.prompt);
    return session;
  }

  async resume(rawRequest: DriverResumeV1): Promise<DriverSessionV1> {
    const request = DriverResumeV1Schema.parse(rawRequest);
    const state = await this.#get(request.sessionId);
    if (state.status !== "running" || state.terminalReason !== null) {
      throw new Error("Codex session is terminal and cannot be resumed");
    }
    const bindingMismatches = [
      state.launch.contextDigest !== request.contextDigest ? "context" : null,
      state.launch.executionContractDigest !== request.executionContractDigest
        ? "execution-contract"
        : null,
      state.launch.capabilityManifestDigest !== request.capabilityManifestDigest
        ? "capability"
        : null,
      state.session.checkpointDigest !== request.checkpointDigest ? "checkpoint" : null
    ].filter(Boolean);
    if (bindingMismatches.length > 0) {
      const checkpointDetail = bindingMismatches.includes("checkpoint")
        ? ` stored=${state.session.checkpointDigest ?? "null"} requested=${request.checkpointDigest}`
        : "";
      throw new Error(
        `Codex resume binding does not match the stored session: ${bindingMismatches.join(",")}${checkpointDetail}`
      );
    }
    if (!state.providerSessionId)
      throw new Error("Codex provider session has not emitted its resume identity");
    state.abortController = new AbortController();
    this.#armTimeout(state);
    const thread = this.#clientFactory().resumeThread(
      state.providerSessionId,
      this.#threadOptions(state.launch)
    );
    void this.#consume(
      state,
      thread,
      `Continue the interrupted task using the unchanged execution and capability contract.\n\n${state.prompt}`
    );
    return state.session;
  }

  async inspect(rawRequest: Parameters<AgentDriverV1["inspect"]>[0]): Promise<DriverEventBatchV1> {
    const request = DriverInspectV1Schema.parse(rawRequest);
    const state = await this.#get(request.sessionId);
    await this.#awaitPersistence(state);
    return DriverEventBatchV1Schema.parse({
      schemaVersion: 1,
      afterSequence: request.afterSequence,
      events: state.events.filter((event) => event.sequence > request.afterSequence),
      status: state.status
    });
  }

  async cancel(
    rawRequest: DriverCancelV1
  ): Promise<{ status: "cancelled"; receiptDigest: string }> {
    const request = DriverCancelV1Schema.parse(rawRequest);
    const state = await this.#get(request.sessionId);
    if (state.status === "running") {
      if (state.timeout) clearTimeout(state.timeout);
      state.abortController?.abort();
      this.#terminal(state, request.reason, request.reason.replaceAll("_", " "));
      await this.#persist(state);
    }
    return { status: "cancelled", receiptDigest: sha256(`${request.effectKey}:${state.status}`) };
  }

  async collectReceipt(sessionId: string): Promise<DriverReceiptV1> {
    const state = await this.#get(sessionId);
    await this.#awaitPersistence(state);
    if (state.status === "running" || !state.completedAt || !state.terminalReason) {
      throw new Error("Codex receipt is unavailable before a terminal event");
    }
    return DriverReceiptV1Schema.parse({
      schemaVersion: 1,
      driverId: this.manifest.id,
      driverVersion: this.manifest.extensionVersion,
      sdkVersion: SDK_VERSION,
      sessionId: state.session.sessionId,
      externalRunId: state.session.externalRunId,
      requestedModel: state.launch.requestedModel,
      observedModels: state.launch.requestedModel ? [state.launch.requestedModel] : [],
      contextDigest: state.launch.contextDigest,
      executionContractDigest: state.launch.executionContractDigest,
      capabilityManifestDigest: state.launch.capabilityManifestDigest,
      eventStreamDigest: sha256(canonical(state.events)),
      rawStreamDigest: state.rawStreamDigest,
      checkpointDigest: state.session.checkpointDigest,
      outcome: state.status,
      terminalReason: state.terminalReason,
      completedAt: state.completedAt
    });
  }

  async close(): Promise<void> {
    for (const state of this.#sessions.values()) {
      if (state.status === "running") {
        state.abortController?.abort();
        this.#terminal(state, "operator_cancelled", "Driver closed");
        await this.#persist(state);
      }
    }
  }

  #threadOptions(request: DriverLaunchV1): ThreadOptions {
    return {
      ...(request.requestedModel ? { model: request.requestedModel } : {}),
      sandboxMode:
        request.capabilityManifest.workspace === "read_write" ? "workspace-write" : "read-only",
      workingDirectory: this.#workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      additionalDirectories: []
    };
  }

  async #consume(state: LiveSession, thread: CodexThreadLike, prompt: string): Promise<void> {
    try {
      const signal = state.abortController?.signal;
      const streamed = await thread.runStreamed(prompt, signal ? { signal } : undefined);
      for await (const raw of streamed.events) {
        const event = parseProviderEvent(raw);
        state.rawStreamDigest = sha256(`${state.rawStreamDigest}:${canonical(event)}`);
        state.rawEventCount += 1;
        const rawEventDigest = sha256(canonical(event));
        if (state.seenRawEventDigests.includes(rawEventDigest)) {
          await this.#persist(state);
          continue;
        }
        state.seenRawEventDigests.push(rawEventDigest);
        if (event.type === "thread.started") {
          state.providerSessionId = event.thread_id;
          const checkpointDigest = sha256(
            canonical({
              provider: "openai",
              providerSessionId: event.thread_id,
              contextDigest: state.launch.contextDigest,
              executionContractDigest: state.launch.executionContractDigest,
              capabilityManifestDigest: state.launch.capabilityManifestDigest
            })
          );
          state.session = DriverSessionV1Schema.parse({ ...state.session, checkpointDigest });
          this.#append(state, { type: "checkpoint", checkpointDigest });
        } else if (event.type === "turn.completed") {
          await this.#appendArtifacts(state);
          this.#append(state, {
            type: "usage",
            provider: "openai",
            requestedModel: state.launch.requestedModel,
            observedModel: state.launch.requestedModel,
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningTokens: event.usage.reasoning_output_tokens,
            monetaryCost: {
              status: "unavailable",
              reason: "Codex SDK does not report monetary cost"
            }
          });
          this.#terminal(state, "succeeded", "Codex turn completed");
        } else if (event.type === "turn.failed" || event.type === "error") {
          this.#terminal(
            state,
            "failed",
            event.type === "error" ? "codex_stream_error" : "codex_turn_failed"
          );
        }
        await this.#persist(state);
      }
      if (state.status === "running")
        this.#terminal(state, "protocol_invalid", "Codex stream ended without terminal event");
    } catch (error) {
      if (state.status === "running") {
        const protocolInvalid =
          error instanceof z.ZodError ||
          (error instanceof Error && error.message.includes("validated size limit"));
        this.#terminal(
          state,
          state.abortController?.signal.aborted
            ? "operator_cancelled"
            : protocolInvalid
              ? "protocol_invalid"
              : "failed",
          state.abortController?.signal.aborted
            ? "operator_cancelled"
            : protocolInvalid
              ? "provider_event_protocol_invalid"
              : "provider_execution_failed"
        );
      }
    }
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
    await this.#persist(state);
  }

  #append(state: LiveSession, event: PendingDriverEvent): void {
    state.events.push({
      schemaVersion: 1,
      sequence: state.events.length + 1,
      occurredAt: this.#clock.now().toISOString(),
      ...event
    });
  }

  #terminal(state: LiveSession, outcome: DriverEventBatchV1["status"], reason: string): void {
    if (state.status !== "running") return;
    const terminalOutcome = outcome === "running" ? "protocol_invalid" : outcome;
    state.status = terminalOutcome;
    state.terminalReason = reason.slice(0, 1000) || "No terminal reason supplied";
    state.completedAt = this.#clock.now().toISOString();
    if (state.timeout) clearTimeout(state.timeout);
    state.timeout = null;
    this.#append(state, {
      type: "terminal",
      outcome: terminalOutcome,
      reason: state.terminalReason
    });
  }

  async #persist(state: LiveSession): Promise<void> {
    const operation = state.persistChain.then(async () => {
      await mkdir(this.#sessionDirectory, { recursive: true, mode: 0o700 });
      const stored: StoredSession = {
        schemaVersion: state.schemaVersion,
        session: state.session,
        providerSessionId: state.providerSessionId,
        prompt: state.prompt,
        launch: state.launch,
        events: state.events,
        rawStreamDigest: state.rawStreamDigest,
        rawEventCount: state.rawEventCount,
        seenRawEventDigests: state.seenRawEventDigests,
        baselineFiles: state.baselineFiles,
        status: state.status,
        terminalReason: state.terminalReason,
        completedAt: state.completedAt
      };
      const path = join(this.#sessionDirectory, `${state.session.sessionId}.json`);
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, canonical(stored), { mode: 0o600 });
      await rename(temporary, path);
    });
    state.persistChain = operation;
    await operation;
  }

  async #get(sessionId: string): Promise<LiveSession> {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const stored = JSON.parse(
      await readFile(join(this.#sessionDirectory, `${sessionId}.json`), "utf8")
    ) as StoredSession;
    const state: LiveSession = {
      ...stored,
      seenRawEventDigests: stored.seenRawEventDigests,
      baselineFiles: stored.baselineFiles,
      abortController: null,
      timeout: null,
      persistChain: Promise.resolve()
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  async #awaitPersistence(state: LiveSession): Promise<void> {
    for (;;) {
      const pending = state.persistChain;
      await pending;
      if (pending === state.persistChain) return;
    }
  }

  #armTimeout(state: LiveSession): void {
    if (state.timeout) clearTimeout(state.timeout);
    const elapsed = Math.max(
      0,
      this.#clock.now().getTime() - new Date(state.session.startedAt).getTime()
    );
    const remaining = Math.max(1, state.launch.capabilityManifest.resources.wallTimeMs - elapsed);
    state.timeout = setTimeout(() => {
      if (state.status !== "running") return;
      this.#terminal(state, "timed_out", "provider_wall_time_expired");
      state.abortController?.abort();
      void this.#persist(state);
    }, remaining);
    state.timeout.unref();
  }

  async #workspaceFiles(): Promise<Record<string, string>> {
    const root = resolve(this.#workspace);
    const files: Record<string, string> = {};
    let count = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if ([".git", ".parallelplay", "node_modules"].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        if (count > 10_000) throw new Error("Provider workspace exceeded the artifact file bound");
        const metadata = await lstat(path);
        if (metadata.size > 100 * 1024 * 1024) {
          throw new Error("Provider workspace artifact exceeded the file size bound");
        }
        const key = relative(root, path).split(sep).join("/");
        if (!key || key.startsWith("../"))
          throw new Error("Provider workspace path escaped its root");
        files[key] = sha256(await readFile(path));
      }
    };
    await visit(root);
    return files;
  }

  async #appendArtifacts(state: LiveSession): Promise<void> {
    const current = await this.#workspaceFiles();
    const existing = new Set(
      state.events
        .filter((event) => event.type === "artifact.declared")
        .map((event) => `${event.path}:${event.sha256}`)
    );
    for (const path of Object.keys(current).sort()) {
      const fileDigest = current[path];
      if (
        !fileDigest ||
        state.baselineFiles[path] === fileDigest ||
        existing.has(`${path}:${fileDigest}`)
      ) {
        continue;
      }
      const bytes = await readFile(resolve(this.#workspace, path));
      this.#append(state, {
        type: "artifact.declared",
        path,
        role: "workspace.output",
        size: bytes.length,
        sha256: fileDigest
      });
    }
  }
}
