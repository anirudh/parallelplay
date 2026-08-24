import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  DriverEventBatchV1Schema,
  DriverReceiptV1Schema,
  DriverSessionV1Schema,
  ExtensionManifestV1Schema,
  type AgentDriverV1,
  type DriverCancelV1,
  type DriverEventBatchV1,
  type DriverLaunchV1,
  type DriverReceiptV1,
  type DriverResumeV1,
  type DriverSessionV1,
  type ExtensionManifestV1
} from "@parallelplay/contracts";
import { z } from "zod";
import type { EnvironmentSecretProvider } from "./secret-provider.js";
import type { ProviderName } from "./provider-broker.js";

const execFileAsync = promisify(execFile);
const DigestPinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);
const RunnerResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.strictObject({ code: z.string().min(1).max(100) }).optional()
});
const RelayReadySchema = z.strictObject({
  schemaVersion: z.literal(1),
  type: z.literal("ready"),
  grant: z.strictObject({
    schemaVersion: z.literal(1),
    token: z.string().min(32).max(512),
    runId: z.string().min(1),
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().min(1),
    expiresAt: z.string().min(1),
    endpoint: z.url(),
    maxBudgetUsd: z.number().positive().nullable(),
    maxOutputTokensPerRequest: z.number().int().positive().max(1_000_000).nullable(),
    grantDigest: z.string().regex(/^[a-f0-9]{64}$/)
  })
});

export interface ContainerAgentDriverOptions {
  manifest: ExtensionManifestV1;
  provider: ProviderName;
  runnerImage: string;
  relayImage: string;
  workspaceRoot: string;
  sessionRoot: string;
  secretEnvironmentName: string;
  secretProvider: EnvironmentSecretProvider;
  maxBudgetUsd: number;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxOutputTokensPerRequest?: number;
  maxRequests?: number;
  dockerBinary?: string;
}

const HostCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1).max(500),
  runId: z.uuid(),
  provider: z.enum(["openai", "anthropic"]),
  requestedModel: z.string().min(1).max(200),
  runnerImage: DigestPinnedImage,
  relayImage: DigestPinnedImage,
  manifestArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  executionContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  capabilityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  terminal: z.boolean()
});
type HostCheckpoint = z.infer<typeof HostCheckpointSchema>;

const StoredProviderSessionSchema = z.looseObject({
  session: z.strictObject({
    sessionId: z.string().min(1).max(500),
    checkpointDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
  }),
  launch: z.looseObject({
    runId: z.uuid(),
    requestedModel: z.string().min(1).max(200).nullable(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
    executionContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    capabilityManifestDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }),
  status: z.enum([
    "running",
    "succeeded",
    "failed",
    "approval_required",
    "capability_violation",
    "protocol_invalid",
    "operator_cancelled",
    "timed_out"
  ]),
  terminalReason: z.string().nullable()
});

interface LiveRuntime {
  runId: string;
  sessionId: string;
  internalNetwork: string;
  egressNetwork: string;
  relayName: string;
  runnerName: string;
  relay: ChildProcessWithoutNullStreams;
  runner: ChildProcessWithoutNullStreams;
  runnerLines: Interface;
  runnerIterator: AsyncIterator<string>;
  commandChain: Promise<unknown>;
}

function containerName(prefix: string, runId: string): string {
  return `${prefix}-${runId.replaceAll("-", "").slice(0, 20)}-${randomUUID().slice(0, 8)}`;
}

function hardenedDockerArgs(
  name: string,
  network: string,
  image: string,
  user = "65534:65534"
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "536870912",
    "--cpus",
    "1",
    "--user",
    user,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216",
    image
  ];
}

export function buildProviderRunnerDockerArgs(options: {
  name: string;
  network: string;
  image: string;
  workspace: string;
  session: string;
}): string[] {
  const uid = process.getuid?.() ?? 65_534;
  const gid = process.getgid?.() ?? 65_534;
  return [
    ...hardenedDockerArgs(
      options.name,
      options.network,
      DigestPinnedImage.parse(options.image),
      `${String(uid)}:${String(gid)}`
    ).slice(0, -1),
    "--mount",
    `type=bind,src=${resolve(options.workspace)},dst=/workspace`,
    "--mount",
    `type=bind,src=${resolve(options.session)},dst=/session`,
    options.image
  ];
}

export class ContainerAgentDriver implements AgentDriverV1 {
  readonly manifest: ExtensionManifestV1;
  readonly #options: Required<
    Pick<ContainerAgentDriverOptions, "maxOutputTokensPerRequest" | "maxRequests" | "dockerBinary">
  > &
    Omit<
      ContainerAgentDriverOptions,
      "maxOutputTokensPerRequest" | "maxRequests" | "dockerBinary" | "manifest"
    >;
  readonly #runtimes = new Map<string, LiveRuntime>();

  constructor(options: ContainerAgentDriverOptions) {
    const manifest = ExtensionManifestV1Schema.parse(options.manifest);
    const runnerImage = DigestPinnedImage.parse(options.runnerImage);
    const relayImage = DigestPinnedImage.parse(options.relayImage);
    if (
      manifest.kind !== "driver" ||
      manifest.contract.name !== "agent-driver-v1" ||
      manifest.artifact.reference !== runnerImage ||
      manifest.artifact.sha256 !== runnerImage.slice(runnerImage.indexOf("sha256:") + 7)
    ) {
      throw new Error("Container driver manifest does not bind the runner image");
    }
    if (options.maxBudgetUsd <= 0 || options.maxBudgetUsd > 100) {
      throw new TypeError("Container driver budget is invalid");
    }
    this.manifest = manifest;
    this.#options = {
      ...options,
      runnerImage,
      relayImage,
      maxOutputTokensPerRequest: options.maxOutputTokensPerRequest ?? 16_384,
      maxRequests: options.maxRequests ?? 128,
      dockerBinary: options.dockerBinary ?? "docker"
    };
  }

  async start(request: DriverLaunchV1): Promise<DriverSessionV1> {
    const network = request.capabilityManifest.network[0];
    if (
      network?.provider !== this.#options.provider ||
      request.requestedModel === null ||
      !network.allowedModels.includes(request.requestedModel)
    ) {
      throw new Error("Provider launch is outside the digest-bound capability manifest");
    }
    const runtime = await this.#launchRuntime(request.runId, request.requestedModel);
    try {
      const session = DriverSessionV1Schema.parse(await this.#command(runtime, "start", request));
      runtime.sessionId = session.sessionId;
      this.#runtimes.set(session.sessionId, runtime);
      await this.#writeCheckpoint({
        schemaVersion: 1,
        sessionId: session.sessionId,
        runId: request.runId,
        provider: this.#options.provider,
        requestedModel: request.requestedModel,
        runnerImage: this.#options.runnerImage,
        relayImage: this.#options.relayImage,
        manifestArtifactDigest: this.manifest.artifact.sha256,
        contextDigest: request.contextDigest,
        executionContractDigest: request.executionContractDigest,
        capabilityManifestDigest: request.capabilityManifestDigest,
        checkpointDigest: session.checkpointDigest,
        terminal: false
      });
      return session;
    } catch (error) {
      await this.#dispose(runtime);
      throw error;
    }
  }

  async resume(request: DriverResumeV1): Promise<DriverSessionV1> {
    const existing = this.#runtimes.get(request.sessionId);
    if (existing) {
      return DriverSessionV1Schema.parse(await this.#command(existing, "resume", request));
    }
    const checkpoint = await this.#validateRestart(request);
    const runtime = await this.#launchRuntime(checkpoint.runId, checkpoint.requestedModel);
    runtime.sessionId = request.sessionId;
    try {
      const session = DriverSessionV1Schema.parse(await this.#command(runtime, "resume", request));
      this.#runtimes.set(request.sessionId, runtime);
      await this.#writeCheckpoint({ ...checkpoint, checkpointDigest: request.checkpointDigest });
      return session;
    } catch (error) {
      await this.#dispose(runtime);
      throw error;
    }
  }

  async inspect(request: {
    schemaVersion: 1;
    sessionId: string;
    afterSequence: number;
  }): Promise<DriverEventBatchV1> {
    const runtime = this.#runtime(request.sessionId);
    const batch = DriverEventBatchV1Schema.parse(await this.#command(runtime, "inspect", request));
    const checkpointEvent = [...batch.events]
      .reverse()
      .find((event) => event.type === "checkpoint");
    if (checkpointEvent?.type === "checkpoint") {
      await this.#updateCheckpoint(request.sessionId, {
        checkpointDigest: checkpointEvent.checkpointDigest,
        terminal: batch.status !== "running"
      });
    } else if (batch.status !== "running") {
      await this.#updateCheckpoint(request.sessionId, { terminal: true });
    }
    return batch;
  }

  async cancel(request: DriverCancelV1): Promise<{ status: "cancelled"; receiptDigest: string }> {
    const runtime = this.#runtime(request.sessionId);
    const result = z
      .strictObject({
        status: z.literal("cancelled"),
        receiptDigest: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .parse(await this.#command(runtime, "cancel", request));
    await this.#updateCheckpoint(request.sessionId, { terminal: true });
    return result;
  }

  async collectReceipt(sessionId: string): Promise<DriverReceiptV1> {
    const runtime = this.#runtime(sessionId);
    const receipt = DriverReceiptV1Schema.parse(
      await this.#command(runtime, "receipt", { sessionId })
    );
    await this.#updateCheckpoint(sessionId, {
      checkpointDigest: receipt.checkpointDigest,
      terminal: true
    });
    return receipt;
  }

  async close(): Promise<void> {
    for (const runtime of [...this.#runtimes.values()]) {
      try {
        await this.#command(runtime, "close", {});
      } catch {
        // Cleanup remains mandatory if the contained protocol has already failed.
      }
      await this.#dispose(runtime);
    }
    this.#runtimes.clear();
  }

  #runtime(sessionId: string): LiveRuntime {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) throw new Error("Provider session is not attached to this runtime");
    return runtime;
  }

  async #launchRuntime(runId: string, model: string): Promise<LiveRuntime> {
    const internalNetwork = containerName("pp-internal", runId);
    const egressNetwork = containerName("pp-egress", runId);
    const relayName = containerName("pp-relay", runId);
    const runnerName = containerName("pp-runner", runId);
    const workspace = resolve(this.#options.workspaceRoot, runId);
    const session = resolve(this.#options.sessionRoot, runId);
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(session, { recursive: true, mode: 0o700 })
    ]);
    let relay: ChildProcessWithoutNullStreams | undefined;
    let runner: ChildProcessWithoutNullStreams | undefined;
    await this.#docker(["network", "create", "--internal", internalNetwork]);
    try {
      await this.#docker(["network", "create", egressNetwork]);
      relay = this.#spawnDocker(
        hardenedDockerArgs(relayName, egressNetwork, this.#options.relayImage)
      );
      relay.stderr.resume();
      await this.#waitForContainer(relayName);
      await this.#docker(["network", "connect", "--alias", relayName, internalNetwork, relayName]);
      const handle = this.#options.secretProvider.issueHandle(
        {
          schemaVersion: 1,
          provider: "environment",
          name: this.#options.secretEnvironmentName,
          purpose: "provider-api",
          allowedConsumer: "provider-container-runtime"
        },
        { runId, now: new Date().toISOString() }
      );
      try {
        const providerSecret = this.#options.secretProvider.consume(
          handle.handleId,
          "provider-container-runtime",
          runId
        );
        relay.stdin.write(
          `${JSON.stringify({
            schemaVersion: 1,
            runId,
            provider: this.#options.provider,
            model,
            providerSecret,
            advertisedHost: relayName,
            ttlMs: 15 * 60_000,
            maxBudgetUsd: this.#options.maxBudgetUsd,
            inputUsdPerMillion: this.#options.inputUsdPerMillion,
            outputUsdPerMillion: this.#options.outputUsdPerMillion,
            maxOutputTokensPerRequest: this.#options.maxOutputTokensPerRequest,
            maxRequests: this.#options.maxRequests
          })}\n`
        );
      } finally {
        this.#options.secretProvider.revoke(handle.handleId);
      }
      const relayLine = createInterface({ input: relay.stdout, crlfDelay: Infinity });
      const readyValue = await this.#nextLine(relayLine[Symbol.asyncIterator](), 30_000);
      relayLine.close();
      const ready = RelayReadySchema.parse(JSON.parse(readyValue) as unknown);
      runner = this.#spawnDocker(
        buildProviderRunnerDockerArgs({
          name: runnerName,
          network: internalNetwork,
          image: this.#options.runnerImage,
          workspace,
          session
        })
      );
      runner.stderr.resume();
      const runnerLines = createInterface({ input: runner.stdout, crlfDelay: Infinity });
      const runtime: LiveRuntime = {
        runId,
        sessionId: "pending",
        internalNetwork,
        egressNetwork,
        relayName,
        runnerName,
        relay,
        runner,
        runnerLines,
        runnerIterator: runnerLines[Symbol.asyncIterator](),
        commandChain: Promise.resolve()
      };
      runner.stdin.write(
        `${JSON.stringify({
          schemaVersion: 1,
          provider: this.#options.provider,
          manifest: this.manifest,
          brokerBaseUrl: ready.grant.endpoint,
          brokerToken: ready.grant.token,
          maxBudgetUsd: this.#options.maxBudgetUsd
        })}\n`
      );
      return runtime;
    } catch (error) {
      runner?.kill("SIGKILL");
      relay?.kill("SIGKILL");
      await this.#removeContainer(runnerName);
      await this.#removeContainer(relayName);
      await this.#removeNetwork(internalNetwork);
      await this.#removeNetwork(egressNetwork);
      throw error;
    }
  }

  async #command(runtime: LiveRuntime, operation: string, input: unknown): Promise<unknown> {
    const requestId = randomUUID();
    const execute = async (): Promise<unknown> => {
      runtime.runner.stdin.write(
        `${JSON.stringify({ schemaVersion: 1, requestId, operation, input })}\n`
      );
      const line = await this.#nextLine(runtime.runnerIterator, 60_000);
      const response = RunnerResponseSchema.parse(JSON.parse(line) as unknown);
      if (response.requestId !== requestId)
        throw new Error("Provider runner response was reordered");
      if (!response.ok) throw new Error(`Provider runner rejected ${operation}`);
      return response.result;
    };
    const result = runtime.commandChain.then(execute, execute);
    runtime.commandChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async #nextLine(iterator: AsyncIterator<string>, timeoutMs: number): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        iterator.next().then((result) => {
          if (result.done) throw new Error("Contained provider process closed its protocol");
          return result.value;
        }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Contained provider protocol timed out")),
            timeoutMs
          );
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  #spawnDocker(args: string[]): ChildProcessWithoutNullStreams {
    return spawn(this.#options.dockerBinary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C"
      }
    });
  }

  async #validateRestart(request: DriverResumeV1): Promise<HostCheckpoint> {
    const checkpoint = await this.#readCheckpoint(request.sessionId);
    if (
      checkpoint.terminal ||
      checkpoint.provider !== this.#options.provider ||
      checkpoint.runnerImage !== this.#options.runnerImage ||
      checkpoint.relayImage !== this.#options.relayImage ||
      checkpoint.manifestArtifactDigest !== this.manifest.artifact.sha256 ||
      checkpoint.contextDigest !== request.contextDigest ||
      checkpoint.executionContractDigest !== request.executionContractDigest ||
      checkpoint.capabilityManifestDigest !== request.capabilityManifestDigest
    ) {
      throw new Error("Provider restart binding does not match the stored host checkpoint");
    }
    const providerState = StoredProviderSessionSchema.parse(
      JSON.parse(
        await readFile(
          join(
            resolve(this.#options.sessionRoot, checkpoint.runId),
            this.#options.provider,
            `${request.sessionId}.json`
          ),
          "utf8"
        )
      ) as unknown
    );
    if (
      providerState.status !== "running" ||
      providerState.terminalReason !== null ||
      providerState.session.sessionId !== request.sessionId ||
      providerState.session.checkpointDigest !== request.checkpointDigest ||
      providerState.launch.runId !== checkpoint.runId ||
      providerState.launch.requestedModel !== checkpoint.requestedModel ||
      providerState.launch.contextDigest !== request.contextDigest ||
      providerState.launch.executionContractDigest !== request.executionContractDigest ||
      providerState.launch.capabilityManifestDigest !== request.capabilityManifestDigest
    ) {
      throw new Error("Provider session is terminal or its restart checkpoint does not match");
    }
    return checkpoint;
  }

  async #readCheckpoint(sessionId: string): Promise<HostCheckpoint> {
    return HostCheckpointSchema.parse(
      JSON.parse(await readFile(this.#checkpointPath(sessionId), "utf8")) as unknown
    );
  }

  async #writeCheckpoint(checkpoint: HostCheckpoint): Promise<void> {
    const parsed = HostCheckpointSchema.parse(checkpoint);
    const directory = resolve(this.#options.sessionRoot, "host-checkpoints");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.#checkpointPath(parsed.sessionId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  async #updateCheckpoint(
    sessionId: string,
    update: Partial<Pick<HostCheckpoint, "checkpointDigest" | "terminal">>
  ): Promise<void> {
    const checkpoint = await this.#readCheckpoint(sessionId);
    await this.#writeCheckpoint({ ...checkpoint, ...update });
  }

  #checkpointPath(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex");
    return join(resolve(this.#options.sessionRoot, "host-checkpoints"), `${key}.json`);
  }

  async #waitForContainer(name: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await this.#docker(["container", "inspect", name]);
        return;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    }
    throw new Error("Provider relay container did not start");
  }

  async #docker(args: string[]): Promise<void> {
    await execFileAsync(this.#options.dockerBinary, args, {
      env: {
        PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C"
      },
      maxBuffer: 1024 * 1024
    });
  }

  async #dispose(runtime: LiveRuntime): Promise<void> {
    runtime.runnerLines.close();
    runtime.runner.kill("SIGKILL");
    runtime.relay.kill("SIGKILL");
    await Promise.all([
      this.#removeContainer(runtime.runnerName),
      this.#removeContainer(runtime.relayName)
    ]);
    await Promise.all([
      this.#removeNetwork(runtime.internalNetwork),
      this.#removeNetwork(runtime.egressNetwork)
    ]);
    if (runtime.sessionId !== "pending") this.#runtimes.delete(runtime.sessionId);
  }

  async #removeContainer(name: string): Promise<void> {
    try {
      await this.#docker(["rm", "--force", name]);
    } catch {
      // The --rm container may already be gone.
    }
  }

  async #removeNetwork(name: string): Promise<void> {
    try {
      await this.#docker(["network", "rm", name]);
    } catch {
      // Cleanup remains idempotent across crash recovery.
    }
  }
}
