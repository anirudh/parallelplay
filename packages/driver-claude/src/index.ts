import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
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

const SDK_VERSION = "0.3.241";
const MAX_PROVIDER_EVENT_BYTES = 2 * 1024 * 1024;
const ClaudeSystemSubtypeSchema = z.enum([
  "api_retry",
  "background_tasks_changed",
  "commands_changed",
  "compact_boundary",
  "control_request_progress",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "init",
  "local_command_output",
  "memory_recall",
  "mirror_error",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "notification",
  "permission_denied",
  "plugin_install",
  "session_state_changed",
  "status",
  "task_notification",
  "task_progress",
  "task_started",
  "task_updated",
  "thinking_tokens",
  "worker_shutting_down"
]);
const ClaudeNonterminalMessageSchema = z.union([
  z.looseObject({
    type: z.literal("system"),
    subtype: ClaudeSystemSubtypeSchema,
    uuid: z.string().min(1),
    session_id: z.string().min(1)
  }),
  z.looseObject({
    type: z.enum([
      "active_goal",
      "assistant",
      "auth_status",
      "conversation_reset",
      "prompt_suggestion",
      "rate_limit_event",
      "stream_event",
      "tool_progress",
      "tool_use_summary"
    ]),
    uuid: z.string().min(1),
    session_id: z.string().min(1)
  }),
  z.looseObject({
    type: z.literal("user"),
    message: z.unknown(),
    parent_tool_use_id: z.string().nullable(),
    uuid: z.string().min(1).optional(),
    session_id: z.string().min(1).optional()
  })
]);
const SystemInitSchema = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string().min(1),
  uuid: z.string().min(1),
  model: z.string().min(1),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
});
const ModelUsageSchema = z.looseObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative()
});
const ResultSchema = z.looseObject({
  type: z.literal("result"),
  subtype: z.enum([
    "success",
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries"
  ]),
  is_error: z.boolean(),
  total_cost_usd: z.number().nonnegative(),
  modelUsage: z.record(z.string(), ModelUsageSchema),
  permission_denials: z.array(z.unknown()),
  session_id: z.string().min(1),
  uuid: z.string().min(1),
  errors: z.array(z.string()).optional()
});
const ClaudeMessageSchema = z.union([
  SystemInitSchema,
  ResultSchema,
  ClaudeNonterminalMessageSchema
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

function parseProviderMessage(raw: unknown): z.infer<typeof ClaudeMessageSchema> {
  const encoded = canonical(raw);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROVIDER_EVENT_BYTES) {
    throw new Error("Claude provider event exceeded the validated size limit");
  }
  return ClaudeMessageSchema.parse(raw);
}

interface ClaudeQueryLike extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
}

interface ClaudeQueryOptions {
  cwd: string;
  env: Record<string, string>;
  settingSources: [];
  systemPrompt: string;
  tools: string[];
  allowedTools: string[];
  permissionMode: "dontAsk";
  model?: string;
  maxTurns: number;
  maxBudgetUsd: number;
  persistSession: true;
  resume?: string;
}

interface ClaudeQueryRequest {
  prompt: string;
  options: ClaudeQueryOptions;
}

export interface ClaudeSdkDriverOptions {
  manifest: ExtensionManifestV1;
  brokerBaseUrl: string;
  brokerToken: string;
  workspace?: string;
  sessionDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  clock?: { now(): Date };
  queryFactory?: (request: ClaudeQueryRequest) => ClaudeQueryLike;
  maxTurns?: number;
  maxBudgetUsd?: number;
}

interface StoredSession {
  schemaVersion: 1;
  session: DriverSessionV1;
  providerSessionId: string | null;
  observedModels: string[];
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
  activeQuery: ClaudeQueryLike | null;
  timeout: NodeJS.Timeout | null;
  persistChain: Promise<void>;
}

type PendingDriverEvent = DriverProtocolEventV1 extends infer Event
  ? Event extends DriverProtocolEventV1
    ? Omit<Event, "schemaVersion" | "sequence" | "occurredAt">
    : never
  : never;

export class ClaudeSdkDriver implements AgentDriverV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #workspace: string;
  readonly #sessionDirectory: string;
  readonly #clock: { now(): Date };
  readonly #queryFactory: (request: ClaudeQueryRequest) => ClaudeQueryLike;
  readonly #maxTurns: number;
  readonly #maxBudgetUsd: number;
  readonly #brokerBaseUrl: string;
  readonly #brokerToken: string;
  readonly #sessions = new Map<string, LiveSession>();

  constructor(options: ClaudeSdkDriverOptions) {
    const environment = options.environment ?? process.env;
    if (environment["PARALLELPLAY_OCI_BOUNDARY"] !== "1") {
      throw new Error(
        "Claude Agent SDK driver refuses to run outside the ParallelPlay OCI boundary"
      );
    }
    const manifest = ExtensionManifestV1Schema.parse(options.manifest);
    if (
      manifest.id !== "claude-agent-sdk" ||
      manifest.kind !== "driver" ||
      manifest.contract.name !== "agent-driver-v1" ||
      manifest.artifact.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
      !manifest.artifact.reference.endsWith(`@sha256:${manifest.artifact.sha256}`)
    ) {
      throw new Error("Claude Agent SDK driver requires a digest-pinned claude-agent-sdk manifest");
    }
    this.manifest = manifest;
    this.#workspace = options.workspace ?? "/workspace";
    this.#sessionDirectory = options.sessionDirectory ?? "/session/claude";
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#queryFactory = options.queryFactory ?? ((request) => query(request));
    this.#maxTurns = options.maxTurns ?? 25;
    this.#maxBudgetUsd = options.maxBudgetUsd ?? 5;
    this.#brokerBaseUrl = options.brokerBaseUrl;
    this.#brokerToken = options.brokerToken;
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
      externalRunId: `claude:${sessionId}`,
      startedAt: now,
      checkpointDigest: null
    });
    const state: LiveSession = {
      schemaVersion: 1,
      session,
      providerSessionId: null,
      observedModels: [],
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
      activeQuery: null,
      timeout: null,
      persistChain: Promise.resolve()
    };
    this.#sessions.set(sessionId, state);
    await this.#persist(state);
    this.#armTimeout(state);
    void this.#consume(state, request.prompt);
    return session;
  }

  async resume(rawRequest: DriverResumeV1): Promise<DriverSessionV1> {
    const request = DriverResumeV1Schema.parse(rawRequest);
    const state = await this.#get(request.sessionId);
    if (state.status !== "running" || state.terminalReason !== null) {
      throw new Error("Claude session is terminal and cannot be resumed");
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
      throw new Error(
        `Claude resume binding does not match the stored session: ${bindingMismatches.join(",")}`
      );
    }
    if (!state.providerSessionId)
      throw new Error("Claude provider session has not emitted its resume identity");
    this.#armTimeout(state);
    void this.#consume(
      state,
      `Continue the interrupted task using the unchanged execution and capability contract.\n\n${state.prompt}`,
      state.providerSessionId
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
      await state.activeQuery?.interrupt();
      this.#terminal(state, request.reason, request.reason.replaceAll("_", " "));
      await this.#persist(state);
    }
    return { status: "cancelled", receiptDigest: sha256(`${request.effectKey}:${state.status}`) };
  }

  async collectReceipt(sessionId: string): Promise<DriverReceiptV1> {
    const state = await this.#get(sessionId);
    await this.#awaitPersistence(state);
    if (state.status === "running" || !state.completedAt || !state.terminalReason) {
      throw new Error("Claude receipt is unavailable before a terminal event");
    }
    return DriverReceiptV1Schema.parse({
      schemaVersion: 1,
      driverId: this.manifest.id,
      driverVersion: this.manifest.extensionVersion,
      sdkVersion: SDK_VERSION,
      sessionId: state.session.sessionId,
      externalRunId: state.session.externalRunId,
      requestedModel: state.launch.requestedModel,
      observedModels: state.observedModels,
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
        await state.activeQuery?.interrupt();
        this.#terminal(state, "operator_cancelled", "Driver closed");
        await this.#persist(state);
      }
    }
  }

  #queryOptions(request: DriverLaunchV1, resume?: string): ClaudeQueryOptions {
    const model = request.requestedModel ?? undefined;
    return {
      cwd: this.#workspace,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/session",
        LANG: "C",
        LC_ALL: "C",
        PARALLELPLAY_OCI_BOUNDARY: "1",
        ANTHROPIC_BASE_URL: this.#brokerBaseUrl,
        ANTHROPIC_API_KEY: this.#brokerToken,
        CLAUDE_AGENT_SDK_CLIENT_APP: "parallelplay/0.1.0"
      },
      settingSources: [],
      systemPrompt:
        "You are a contained software worker. Use only declared tools and the provided workspace. Never request broader authority or credentials.",
      tools: ["Read", "Edit", "Write", "Bash"],
      allowedTools: ["Read", "Edit", "Write", "Bash"],
      permissionMode: "dontAsk",
      ...(model ? { model } : {}),
      maxTurns: this.#maxTurns,
      maxBudgetUsd: this.#maxBudgetUsd,
      persistSession: true,
      ...(resume ? { resume } : {})
    };
  }

  async #consume(state: LiveSession, prompt: string, resume?: string): Promise<void> {
    try {
      const activeQuery = this.#queryFactory({
        prompt,
        options: this.#queryOptions(state.launch, resume)
      });
      state.activeQuery = activeQuery;
      for await (const raw of activeQuery) {
        const message = parseProviderMessage(raw);
        state.rawStreamDigest = sha256(`${state.rawStreamDigest}:${canonical(message)}`);
        state.rawEventCount += 1;
        const rawEventDigest = sha256(canonical(message));
        if (state.seenRawEventDigests.includes(rawEventDigest)) {
          await this.#persist(state);
          continue;
        }
        state.seenRawEventDigests.push(rawEventDigest);
        if (message.type === "system" && message.subtype === "init") {
          const init = SystemInitSchema.parse(message);
          state.providerSessionId = init.session_id;
          if (!state.observedModels.includes(init.model)) state.observedModels.push(init.model);
          const checkpointDigest = sha256(
            canonical({
              provider: "anthropic",
              providerSessionId: init.session_id,
              contextDigest: state.launch.contextDigest,
              executionContractDigest: state.launch.executionContractDigest,
              capabilityManifestDigest: state.launch.capabilityManifestDigest
            })
          );
          state.session = DriverSessionV1Schema.parse({ ...state.session, checkpointDigest });
          this.#append(state, { type: "checkpoint", checkpointDigest });
        } else if (message.type === "result") {
          const result = ResultSchema.parse(message);
          for (const model of Object.keys(result.modelUsage)) {
            if (!state.observedModels.includes(model)) state.observedModels.push(model);
          }
          const usage = Object.values(result.modelUsage).reduce(
            (total, model) => ({
              inputTokens: total.inputTokens + model.inputTokens,
              cachedInputTokens: total.cachedInputTokens + model.cacheReadInputTokens,
              outputTokens: total.outputTokens + model.outputTokens,
              cost: total.cost + model.costUSD
            }),
            { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 }
          );
          this.#append(state, {
            type: "usage",
            provider: "anthropic",
            requestedModel: state.launch.requestedModel,
            observedModel: state.observedModels[0] ?? null,
            inputTokens: usage.inputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: null,
            monetaryCost: {
              status: "known",
              amount: Math.max(result.total_cost_usd, usage.cost).toFixed(8),
              currency: "USD",
              pricingSource: `Claude Agent SDK ${SDK_VERSION} estimated total`
            }
          });
          await this.#appendArtifacts(state);
          if (result.permission_denials.length > 0) {
            this.#append(state, {
              type: "approval.requested",
              requestId: randomUUID(),
              capability: "provider-tool",
              reason: "Claude requested a tool operation outside the declared automatic permissions"
            });
            this.#terminal(
              state,
              "approval_required",
              "Claude reported one or more permission denials"
            );
          } else if (result.subtype === "success" && !result.is_error) {
            this.#terminal(state, "succeeded", "Claude turn completed");
          } else {
            this.#terminal(state, "failed", `claude_${result.subtype}`);
          }
        }
        await this.#persist(state);
      }
      if (state.status === "running")
        this.#terminal(state, "protocol_invalid", "Claude stream ended without terminal result");
    } catch (error) {
      if (state.status === "running") {
        const protocolInvalid =
          error instanceof z.ZodError ||
          (error instanceof Error && error.message.includes("validated size limit"));
        this.#terminal(
          state,
          protocolInvalid ? "protocol_invalid" : "failed",
          protocolInvalid ? "provider_event_protocol_invalid" : "provider_execution_failed"
        );
      }
    } finally {
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = null;
      state.activeQuery = null;
      await this.#persist(state);
    }
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
        observedModels: state.observedModels,
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
      activeQuery: null,
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
      void state.activeQuery?.interrupt();
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
