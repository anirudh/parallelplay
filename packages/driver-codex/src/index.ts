import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Codex, type ThreadEvent, type ThreadOptions } from "@openai/codex-sdk";
import {
  DriverCancelV1Schema,
  DriverEventBatchV1Schema,
  DriverInspectV1Schema,
  DriverLaunchV1Schema,
  DriverReceiptV1Schema,
  DriverResumeV1Schema,
  DriverSessionV1Schema,
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
const RawEventSchema = z.looseObject({ type: z.string().min(1) });

function sha256(value: string): string {
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
  image: string;
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
  status: DriverEventBatchV1["status"];
  terminalReason: string | null;
  completedAt: string | null;
}

interface LiveSession extends StoredSession {
  abortController: AbortController | null;
}

type PendingDriverEvent = DriverProtocolEventV1 extends infer Event
  ? Event extends DriverProtocolEventV1
    ? Omit<Event, "schemaVersion" | "sequence" | "occurredAt">
    : never
  : never;

function manifest(image: string): ExtensionManifestV1 {
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Codex driver image must be digest pinned");
  return {
    schemaVersion: 1,
    id: "codex-sdk",
    displayName: "Codex SDK",
    extensionVersion: "0.1.0",
    kind: "driver",
    contract: { name: "agent-driver-v1", version: 1 },
    artifact: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      reference: image,
      sha256: image.slice(image.indexOf("sha256:") + 7)
    },
    configurationSchemaDigest: sha256("codex-sdk-driver-config-v1"),
    capabilities: [
      { name: "provider-api", required: true, detail: "Run-bound OpenAI broker grant" },
      { name: "workspace", required: true, detail: "Contained writable workspace" }
    ],
    provenance: {
      sourceRepository: "https://github.com/anirudh/parallelplay",
      sourceRevision: sha256("parallelplay-v0.1.0"),
      sbomDigest: sha256("codex-sdk-driver-sbom-v1"),
      attestationDigest: sha256("codex-sdk-driver-attestation-v1")
    },
    conformance: {
      suiteVersion: "0.1.0",
      reportDigest: sha256("codex-sdk-driver-conformance-pending"),
      approvedRegistryDigest: null
    }
  };
}

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
    this.manifest = manifest(options.image);
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
      status: "running",
      terminalReason: null,
      completedAt: null,
      abortController: new AbortController()
    };
    this.#sessions.set(sessionId, state);
    await this.#persist(state);
    const thread = this.#clientFactory().startThread(this.#threadOptions(request));
    void this.#consume(state, thread, request.prompt);
    return session;
  }

  async resume(rawRequest: DriverResumeV1): Promise<DriverSessionV1> {
    const request = DriverResumeV1Schema.parse(rawRequest);
    const state = await this.#get(request.sessionId);
    if (state.status !== "running" || state.terminalReason !== null) {
      throw new Error("Codex session is terminal and cannot be resumed");
    }
    if (
      state.launch.contextDigest !== request.contextDigest ||
      state.launch.executionContractDigest !== request.executionContractDigest ||
      state.launch.capabilityManifestDigest !== request.capabilityManifestDigest ||
      state.session.checkpointDigest !== request.checkpointDigest
    ) {
      throw new Error("Codex resume binding does not match the stored session");
    }
    if (!state.providerSessionId)
      throw new Error("Codex provider session has not emitted its resume identity");
    state.abortController = new AbortController();
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
      state.abortController?.abort();
      this.#terminal(state, request.reason, request.reason.replaceAll("_", " "));
      await this.#persist(state);
    }
    return { status: "cancelled", receiptDigest: sha256(`${request.effectKey}:${state.status}`) };
  }

  async collectReceipt(sessionId: string): Promise<DriverReceiptV1> {
    const state = await this.#get(sessionId);
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
        const event = RawEventSchema.parse(raw) as ThreadEvent;
        state.rawStreamDigest = sha256(`${state.rawStreamDigest}:${canonical(event)}`);
        state.rawEventCount += 1;
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
            event.type === "error" ? event.message : event.error.message
          );
        }
        await this.#persist(state);
      }
      if (state.status === "running")
        this.#terminal(state, "protocol_invalid", "Codex stream ended without terminal event");
    } catch (error) {
      if (state.status === "running") {
        this.#terminal(
          state,
          state.abortController?.signal.aborted ? "operator_cancelled" : "failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
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
    this.#append(state, {
      type: "terminal",
      outcome: terminalOutcome,
      reason: state.terminalReason
    });
  }

  async #persist(state: LiveSession): Promise<void> {
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
      status: state.status,
      terminalReason: state.terminalReason,
      completedAt: state.completedAt
    };
    await writeFile(
      join(this.#sessionDirectory, `${state.session.sessionId}.json`),
      canonical(stored),
      {
        mode: 0o600
      }
    );
  }

  async #get(sessionId: string): Promise<LiveSession> {
    const existing = this.#sessions.get(sessionId);
    if (existing) return existing;
    const stored = JSON.parse(
      await readFile(join(this.#sessionDirectory, `${sessionId}.json`), "utf8")
    ) as StoredSession;
    const state: LiveSession = { ...stored, abortController: null };
    this.#sessions.set(sessionId, state);
    return state;
  }
}
