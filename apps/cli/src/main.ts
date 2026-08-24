#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  artifactManifestDigest,
  IntegrationTargetInputV1Schema,
  KernelSetupError,
  getMigrationStatus,
  migrateDatabase,
  openKernel,
  SqliteOutboundAuthority,
  renderTaskProjection
} from "@parallelplay/kernel";
import type { Command, JobState, Kernel, OutboxState, StateReference } from "@parallelplay/kernel";
import { startAttentionServer } from "@parallelplay/attention";
import { GitHubAppTokenProvider } from "@parallelplay/adapter-github";
import { GuidedGitHubAppSetup } from "@parallelplay/adapter-github/guided-setup";
import { runGitHubFixturePilot } from "@parallelplay/adapter-github/live-pilot";
import { ExtensionManifestV1Schema } from "@parallelplay/contracts";
import { startExplorerServer } from "@parallelplay/explorer";
import {
  SqliteFakeAgentDriver,
  DriverRegistry,
  GenericCommandDriver,
  IntegrationSupervisor,
  Supervisor,
  FileArtifactStore,
  ManagedGitRevisionStore,
  TrustedCommandVerifier,
  getArtifactStoreStatus,
  getFakeAgentMigrationStatus,
  getDriverStoreStatus,
  getSourceStoreStatus,
  initializeArtifactStore,
  initializeDriverStore,
  initializeSourceStore,
  migrateFakeAgentDatabase,
  dockerPreflight,
  verifyDriverEvidence,
  verifyEvidence,
  AttentionDeliverySupervisor,
  ConformanceAttentionPageAdapter,
  AdvisorSupervisor,
  ContainedAdvisorDriver
} from "@parallelplay/runtime";

class CliInputError extends Error {}

interface ParsedArguments {
  positional: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parseArguments(args: string[]): ParsedArguments {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (value === "--help") {
      positional.push("help");
      continue;
    }
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith("--")) {
      if (name === "accepted" || name === "rejected") {
        flags.add(name);
        continue;
      }
      throw new CliInputError(`Missing value for --${name}`);
    }
    if (options.has(name)) throw new CliInputError(`Duplicate option --${name}`);
    options.set(name, optionValue);
    index += 1;
  }
  return { positional, options, flags };
}

function option(args: ParsedArguments, name: string): string {
  const value = args.options.get(name);
  if (!value) throw new CliInputError(`Missing required option --${name}`);
  return value;
}

function uuidOption(args: ParsedArguments, name: string): string {
  const value = option(args, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CliInputError(`--${name} must be a UUID`);
  }
  return value;
}

const jobStatuses: JobState["status"][] = [
  "blocked",
  "ready",
  "active",
  "retry_wait",
  "succeeded",
  "failed",
  "cancelled"
];
const outboxStatuses: OutboxState["status"][] = [
  "pending",
  "leased",
  "delivered",
  "obsolete",
  "dead_letter"
];

function statusOption<T extends string>(args: ParsedArguments, allowed: T[]): T | undefined {
  const value = args.options.get("status");
  if (value === undefined) return undefined;
  const matching = allowed.find((candidate) => candidate === value);
  if (matching === undefined) {
    throw new CliInputError(`Unsupported --status value: ${value}`);
  }
  return matching;
}

function integerOption(args: ParsedArguments, name: string, fallback?: number): number {
  const raw = args.options.get(name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined) throw new CliInputError(`Missing required option --${name}`);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new CliInputError(`--${name} must be an integer`);
  return value;
}

function readJsonFile(file: string, label: string): unknown {
  if (statSync(file).size > 1024 * 1024) throw new CliInputError(`${label} file exceeds 1 MiB`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new CliInputError(`${label} file is not valid JSON`);
  }
}

function commandEnvelope(args: ParsedArguments): Pick<Command, "idempotencyKey" | "actor"> {
  return {
    idempotencyKey: option(args, "idempotency-key"),
    actor: { kind: "operator", id: args.options.get("actor-id") ?? "local-cli" }
  };
}

function writeJson(stream: NodeJS.WriteStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function preparedImage(args: ParsedArguments): string | undefined {
  const explicit = args.options.get("image");
  if (explicit) return explicit;
  const marker = resolve(args.options.get("image-file") ?? ".parallelplay-sandbox-image");
  return existsSync(marker) ? readFileSync(marker, "utf8").trim() : undefined;
}

function listAnswer(value: string): string[] {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runInterviewGuide(args: ParsedArguments): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliInputError(
      "interview guide requires an interactive TTY; automation should write the same import schema and use interview capture --file"
    );
  }
  const output = resolve(option(args, "output"));
  if (existsSync(output)) throw new CliInputError("Interview guide output already exists");
  const programId = uuidOption(args, "program-id");
  const interviewId = args.options.has("interview-id")
    ? uuidOption(args, "interview-id")
    : randomUUID();
  const playbackId = args.options.has("playback-id")
    ? uuidOption(args, "playback-id")
    : randomUUID();
  const questions = [
    ["objective", "What single objective should this program achieve?"],
    ["desired_behaviors", "Desired behaviors (separate multiple entries with semicolons):"],
    ["non_goals", "Non-goals (separate multiple entries with semicolons):"],
    ["edge_cases", "Important edge cases (separate multiple entries with semicolons):"],
    ["ownership_boundaries", "Ownership boundaries (separate multiple entries with semicolons):"],
    ["success_measures", "Success measures (separate multiple entries with semicolons):"],
    ["risk_tolerance", "Risk tolerance (low, normal, high, or reserved):"],
    ["tenets", "Three to seven tenets (separate entries with semicolons):"]
  ] as const;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const transcript: { questionId: string; question: string; answer: string }[] = [];
    for (const [questionId, question] of questions) {
      const answer = (await readline.question(`${question}\n> `)).trim();
      if (!answer) throw new CliInputError(`Answer required for ${questionId}`);
      transcript.push({ questionId, question, answer });
    }
    const byId = new Map(transcript.map((turn) => [turn.questionId, turn.answer]));
    const riskTolerance = byId.get("risk_tolerance");
    if (!riskTolerance || !["low", "normal", "high", "reserved"].includes(riskTolerance)) {
      throw new CliInputError("Risk tolerance must be low, normal, high, or reserved");
    }
    const tenets = listAnswer(byId.get("tenets") ?? "");
    if (tenets.length < 3 || tenets.length > 7) {
      throw new CliInputError("The interview must capture three to seven tenets");
    }
    const payload = {
      schemaVersion: 1,
      interviewId,
      playbackId,
      programId,
      transcript,
      answers: {
        objective: byId.get("objective"),
        desiredBehaviors: listAnswer(byId.get("desired_behaviors") ?? ""),
        nonGoals: listAnswer(byId.get("non_goals") ?? ""),
        edgeCases: listAnswer(byId.get("edge_cases") ?? ""),
        ownershipBoundaries: listAnswer(byId.get("ownership_boundaries") ?? ""),
        successMeasures: listAnswer(byId.get("success_measures") ?? ""),
        riskTolerance,
        tenets
      }
    };
    if (
      payload.answers.desiredBehaviors.length === 0 ||
      payload.answers.ownershipBoundaries.length === 0 ||
      payload.answers.successMeasures.length === 0
    ) {
      throw new CliInputError(
        "Desired behaviors, ownership boundaries, and success measures each require an entry"
      );
    }
    writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeJson(process.stdout, { ok: true, output, interviewId, playbackId, programId });
    return 0;
  } finally {
    readline.close();
  }
}

async function currentGlobalPosition(kernel: Kernel): Promise<number> {
  let afterPosition = 0;
  for (;;) {
    const page = await kernel.listEvents({ afterPosition, limit: 1_000 });
    const last = page.events.at(-1)?.globalPosition;
    if (last !== undefined) afterPosition = last;
    if (page.nextPosition === null) return afterPosition;
  }
}

function help(): object {
  return {
    ok: true,
    commands: [
      "db status --db <path>",
      "db migrate --db <path>",
      "fake-agent status --fake-db <path>",
      "fake-agent migrate --fake-db <path>",
      "source-store status --source-root <path>",
      "source-store init --source-root <path>",
      "artifact-store status --artifact-root <path>",
      "artifact-store init --artifact-root <path>",
      "driver-store status --driver-root <path>",
      "driver-store init --driver-root <path>",
      "sandbox status [--image <sha256>] [--image-file <path>]",
      "sandbox preflight [--image <sha256>] [--image-file <path>]",
      "id new",
      "program create --db <path> --program-id <uuid> --name <name> --idempotency-key <key>",
      "program kickoff --db <path> --file <kickoff.json> --idempotency-key <key>",
      "interview guide --program-id <uuid> --output <file> [--interview-id <uuid>] [--playback-id <uuid>]",
      "interview capture --db <path> --file <interview.json> --idempotency-key <key>",
      "interview list|show --db <path> [--program-id <uuid>] [--interview-id <uuid>]",
      "program-graph approve --db <path> --file <graph.json> --actor-id <id> --idempotency-key <key>",
      "program-graph list|show --db <path> [--program-id <uuid>] [--graph-revision-id <uuid>]",
      "program start --db <path> --file <start.json> --actor-id <id> --idempotency-key <key>",
      "program list --db <path>",
      "program show --db <path> --program-id <uuid>",
      "program approve --db <path> --file <approval.json> --actor-id <id> --idempotency-key <key>",
      "workflow register --db <path> --file <workflow.json> --idempotency-key <key>",
      "revision capture --db <path> --source-root <path> --repository-id <uuid> --revision-id <uuid> --repo <path> --ref <ref> --idempotency-key <key>",
      "revision list --db <path>",
      "revision show --db <path> --revision-id <uuid>",
      "run create --db <path> --run-id <uuid> --program-id <uuid> --workflow-id <uuid> --workflow-version <n> --idempotency-key <key>",
      "run schedule --db <path> --file <manifest.json> --idempotency-key <key>",
      "run cancel --db <path> --run-id <uuid> --reason <text> --idempotency-key <key>",
      "milestone start --db <path> --file <start.json> --actor-id <id> --idempotency-key <key>",
      "milestone list --db <path> [--program-id <uuid>]",
      "milestone show --db <path> --milestone-id <uuid>",
      "generation list|show --db <path> [--program-id <uuid>] [--generation-id <uuid>]",
      "context list|show --db <path> [--program-id <uuid>] [--context-packet-id <uuid>]",
      "outcome-packet list --db <path> [--program-id <uuid>]",
      "outcome-packet show --db <path> --outcome-packet-id <uuid>",
      "outcome-packet verify --db <path> --outcome-packet-id <uuid>",
      "outcome-packet disposition --db <path> --outcome-packet-id <uuid> (--accepted|--rejected) [--reason <text>] --actor-id <id> --idempotency-key <key>",
      "outcome-validation list|show --db <path> [--program-id <uuid>] [--validation-id <uuid>]",
      "issue raise --db <path> --file <issue.json> --idempotency-key <key>",
      "issue resolve --db <path> --file <resolution.json> --actor-id <id> --idempotency-key <key>",
      "issue list|show --db <path> [--program-id <uuid>] [--issue-id <uuid>]",
      "attention start --db <path> --program-id <uuid> --attention-span-id <uuid> --label <text> --actor-id <id> --idempotency-key <key>",
      "attention stop --db <path> --attention-span-id <uuid> --actor-id <id> --idempotency-key <key>",
      "attention list|show --db <path> [--program-id <uuid>] [--attention-span-id <uuid>]",
      "attention-policy approve --db <path> --file <policy.json> --actor-id <id> --idempotency-key <key>",
      "attention-policy list|show --db <path> [--policy-revision-id <uuid>]",
      "portfolio-policy approve --db <path> --file <policy.json> --actor-id <id> --idempotency-key <key>",
      "portfolio-policy list|show --db <path> [--policy-revision-id <uuid>]",
      "integration-target approve --db <path> --source-root <path> --file <target.json> --actor-id <id> --idempotency-key <key>",
      "integration-target list|show --db <path> [--target-revision-id <uuid>]",
      "decision request --db <path> --file <request.json> --actor-id <id> --idempotency-key <key>",
      "decision compile --db <path> --file <source.json> --idempotency-key <key>",
      "decision acknowledge|approve|retry|cancel|park|reprioritize|integrate --db <path> --file <payload.json> --actor-id <id> --idempotency-key <key>",
      "decision list|show|audit --db <path> [--program-id <uuid>] [--packet-id <uuid>]",
      "attention-queue list --db <path> [--program-id <uuid>] [--route <queue|page>]",
      "attention-evidence list|show --db <path> [--packet-id <uuid>] [--evidence-bundle-id <uuid>]",
      "attention-precedent list|show --db <path> [--program-id <uuid>] [--precedent-id <uuid>]",
      "attention-delivery list|show --db <path> [--program-id <uuid>] [--delivery-id <uuid>]",
      "attention-delivery once|run --db <path> --supervisor-id <uuid> [--max-ticks <n>]",
      "attention-budget list|show --db <path> [--program-id <uuid>] [--incident-id <uuid>]",
      "attention-measurement-report compile|list|show --db <path> --program-id <uuid> [--report-id <uuid>]",
      "attention-digest compile|list|show --db <path> --program-id <uuid> [--artifact-id <uuid>]",
      "attention-app serve --db <path> --operator-id <id> [--port <n>] [--github-manifest <path> --github-pilot-output <path>]",
      "advisor-subject approve|list|show --db <path> [--file <subject.json>] [--subject-id <uuid>]",
      "advisor-case record|list|show --db <path> [--file <case.json>] [--case-id <uuid>] [--program-id <uuid>]",
      "advisor-corpus approve|list|show --db <path> [--file <corpus.json>] [--corpus-revision-id <uuid>]",
      "advisor-contamination record|list|show --db <path> [--file <record.json>] [--contamination-id <uuid>]",
      "advisor-invocation queue|cancel|list|show --db <path> [--file <invocation.json>] [--invocation-id <uuid>]",
      "advisor-recommendation list|show --db <path> [--recommendation-id <uuid>] [--program-id <uuid>]",
      "advisor-supervisor once|run --db <path> --supervisor-id <uuid> [--docker-binary <path>] [--max-ticks <n>]",
      "advisor-evaluation compile|list|show --db <path> [--file <evaluation.json>] [--report-id <uuid>] [--policy-revision-id <uuid>]",
      "decision-policy-proposal compile|close|list|show --db <path> [--file <proposal.json>] [--proposal-id <uuid>]",
      "decision-policy approve|list|show|suspend --db <path> [--file <policy.json>] [--policy-revision-id <uuid>]",
      "advisor-promotion compile|list|show --db <path> [--file <promotion.json>] [--promotion-id <uuid>]",
      "decision promote-advisor-policy --db <path> --file <decision.json> --actor-id <id> --idempotency-key <key>",
      "advisor-resolution resolve|list|show --db <path> [--file <resolution.json>] [--resolution-id <uuid>] [--program-id <uuid>]",
      "advisor-audit record|list|show --db <path> [--file <audit.json>] [--audit-id <uuid>] [--policy-revision-id <uuid>]",
      "advisor-incident list|show --db <path> [--incident-id <uuid>] [--policy-revision-id <uuid>]",
      "advisor snapshot --db <path>",
      "outcome-disposition list|show --db <path> [--program-id <uuid>] [--outcome-packet-id <uuid>]",
      "measurement-report compile --db <path> --program-id <uuid> --report-id <uuid> --actor-id <id> --idempotency-key <key>",
      "measurement-report list|show --db <path> [--program-id <uuid>] [--report-id <uuid>]",
      "task-projection render --db <path> --output-root <absolute-path>",
      "explorer serve --db <path> --source-root <path> --artifact-root <path> [--port <n>]",
      "supervisor once --db <path> --fake-db <path> --driver-root <path> --source-root <path> --artifact-root <path> --supervisor-id <uuid> [--docker-binary <path>]",
      "supervisor run --db <path> --fake-db <path> --driver-root <path> --source-root <path> --artifact-root <path> --supervisor-id <uuid> [--docker-binary <path>] [--max-ticks <n>]",
      "integration-supervisor once|run --db <path> --source-root <path> --artifact-root <path> --supervisor-id <uuid> [--max-ticks <n>]",
      "portfolio snapshot --db <path>",
      "admission list|show --db <path> [--program-id <uuid>] [--admission-id <uuid>]",
      "lease list|show --db <path> [--program-id <uuid>] [--lease-id <uuid>]",
      "candidate-diff list|show --db <path> [--manifest-id <uuid>]",
      "integration-candidate list|show --db <path> [--candidate-id <uuid>]",
      "integration-work list|show --db <path> [--work-id <uuid>]",
      "integration-conflict list|show --db <path> [--conflict-id <uuid>]",
      "integration-verification list|show --db <path> [--verification-id <uuid>]",
      "promotion-receipt list|show --db <path> [--receipt-id <uuid>]",
      "portfolio-slo list|show --db <path> [--incident-id <uuid>]",
      "portfolio-report compile|list|show --db <path> --report-id <uuid>",
      "state show --db <path> --kind <state-kind> --id <uuid> [--version <n>]",
      "job list --db <path> [--run-id <uuid>] [--status <status>]",
      "job show --db <path> --job-id <uuid>",
      "outbox list --db <path> [--run-id <uuid>] [--status <status>]",
      "outbox show --db <path> --outbox-id <uuid>",
      "artifact list --db <path> [--run-id <uuid>]",
      "artifact show --db <path> --artifact-manifest-id <uuid>",
      "artifact verify --db <path> --artifact-root <path> --artifact-manifest-id <uuid>",
      "verification list --db <path> [--run-id <uuid>]",
      "verification show --db <path> --verification-id <uuid>",
      "verification verify --db <path> --source-root <path> --artifact-root <path> --verification-id <uuid>",
      "driver-receipt list --db <path> [--run-id <uuid>]",
      "driver-receipt show --db <path> --driver-receipt-id <uuid>",
      "approval-request list --db <path> [--run-id <uuid>]",
      "approval-request show --db <path> --approval-request-id <uuid>",
      "evidence verify --db <path> --source-root <path> --artifact-root <path> --driver-receipt-id <uuid>",
      "events list --db <path> [--after <position>] [--limit <n>]",
      "trace show --db <path> --run-id <uuid>",
      "projection verify --db <path>",
      "projection rebuild --db <path>"
    ]
  };
}

async function executeCommand(kernel: Kernel, command: unknown): Promise<number> {
  const result = await kernel.execute(command);
  if (result.ok) {
    writeJson(process.stdout, result);
    return 0;
  }
  writeJson(process.stderr, result);
  return result.error.code === "VALIDATION_ERROR" ? 2 : 3;
}

async function withKernel(
  databasePath: string,
  operation: (kernel: Kernel) => Promise<number>
): Promise<number> {
  const kernel = await openKernel({ databasePath });
  try {
    return await operation(kernel);
  } finally {
    await kernel.close();
  }
}

async function runSupervisor(args: ParsedArguments, once: boolean): Promise<number> {
  const sourceStore = new ManagedGitRevisionStore(option(args, "source-root"));
  const artifactStore = new FileArtifactStore(option(args, "artifact-root"));
  const verifier = new TrustedCommandVerifier({ sourceStore, artifactStore });
  const kernel = await openKernel({ databasePath: option(args, "db") });
  let drivers: DriverRegistry | undefined;
  try {
    drivers = new DriverRegistry([
      new SqliteFakeAgentDriver({ databasePath: option(args, "fake-db") }),
      new GenericCommandDriver({
        root: option(args, "driver-root"),
        sourceStore,
        artifactStore,
        ...(args.options.get("docker-binary")
          ? { dockerBinary: option(args, "docker-binary") }
          : {})
      })
    ]);
    const supervisorId = uuidOption(args, "supervisor-id");
    const supervisor = new Supervisor({
      kernel,
      drivers,
      verifier,
      supervisorId,
      onRecord: (record) =>
        writeJson(record.action === "command_rejected" ? process.stderr : process.stdout, record)
    });
    if (once) {
      const result = await supervisor.tick();
      if (result.action === "idle") writeJson(process.stdout, result);
      return result.action === "command_rejected" ? 3 : 0;
    }
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const maxTicksRaw = args.options.get("max-ticks");
      const ticks = await supervisor.run({
        signal: abort.signal,
        ...(maxTicksRaw === undefined ? {} : { maxTicks: integerOption(args, "max-ticks") })
      });
      writeJson(process.stdout, { action: "supervisor_stopped", supervisorId, ticks });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await drivers?.close();
    await kernel.close();
  }
}

async function runIntegrationSupervisor(args: ParsedArguments, once: boolean): Promise<number> {
  const sourceStore = new ManagedGitRevisionStore(option(args, "source-root"));
  const artifactStore = new FileArtifactStore(option(args, "artifact-root"));
  const kernel = await openKernel({ databasePath: option(args, "db") });
  try {
    const supervisorId = uuidOption(args, "supervisor-id");
    const supervisor = new IntegrationSupervisor({
      kernel,
      sourceStore,
      verifier: new TrustedCommandVerifier({ sourceStore, artifactStore }),
      supervisorId
    });
    if (once) {
      const result = await supervisor.tick();
      writeJson(result.action === "command_rejected" ? process.stderr : process.stdout, result);
      return result.action === "command_rejected" ? 3 : 0;
    }
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const maxTicksRaw = args.options.get("max-ticks");
      const ticks = await supervisor.run({
        signal: abort.signal,
        ...(maxTicksRaw === undefined ? {} : { maxTicks: integerOption(args, "max-ticks") })
      });
      writeJson(process.stdout, { action: "integration_supervisor_stopped", supervisorId, ticks });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await kernel.close();
  }
}

async function runExplorer(args: ParsedArguments): Promise<number> {
  const port = integerOption(args, "port", 0);
  if (port < 0 || port > 65_535) throw new CliInputError("--port must be between 0 and 65535");
  const server = await startExplorerServer({
    databasePath: option(args, "db"),
    sourceRoot: option(args, "source-root"),
    artifactRoot: option(args, "artifact-root"),
    port
  });
  writeJson(process.stdout, {
    ok: true,
    action: "explorer_started",
    host: server.host,
    port: server.port,
    url: server.url
  });
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await server.close();
  }
}

async function runAttentionDelivery(args: ParsedArguments, once: boolean): Promise<number> {
  const kernel = await openKernel({ databasePath: option(args, "db") });
  try {
    const supervisorId = uuidOption(args, "supervisor-id");
    const supervisor = new AttentionDeliverySupervisor({
      kernel,
      adapter: new ConformanceAttentionPageAdapter(),
      supervisorId,
      onRecord: (record) =>
        writeJson(record.action === "command_rejected" ? process.stderr : process.stdout, record)
    });
    if (once) {
      const result = await supervisor.tick();
      return result.action === "command_rejected" ? 3 : 0;
    }
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const maxTicksRaw = args.options.get("max-ticks");
      const ticks = await supervisor.run({
        signal: abort.signal,
        ...(maxTicksRaw === undefined ? {} : { maxTicks: integerOption(args, "max-ticks") })
      });
      writeJson(process.stdout, {
        action: "attention_delivery_supervisor_stopped",
        supervisorId,
        ticks
      });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await kernel.close();
  }
}

async function runAttentionApp(args: ParsedArguments): Promise<number> {
  const port = integerOption(args, "port", 0);
  if (port < 0 || port > 65_535) throw new CliInputError("--port must be between 0 and 65535");
  const databasePath = option(args, "db");
  const outboundAuthority = SqliteOutboundAuthority.open({ databasePath });
  const githubSetup = new GuidedGitHubAppSetup();
  const githubEnvironment = {
    appId: process.env["GITHUB_APP_ID"],
    installationId: process.env["GITHUB_APP_INSTALLATION_ID"],
    privateKey: process.env["GITHUB_APP_PRIVATE_KEY"]
  };
  const environmentTokenProvider =
    githubEnvironment.appId && githubEnvironment.installationId && githubEnvironment.privateKey
      ? new GitHubAppTokenProvider({
          appId: githubEnvironment.appId,
          installationId: githubEnvironment.installationId,
          privateKey: githubEnvironment.privateKey
        })
      : null;
  const githubManifestPath = args.options.get("github-manifest");
  const githubPilotOutput = args.options.get("github-pilot-output");
  if ((githubManifestPath === undefined) !== (githubPilotOutput === undefined)) {
    outboundAuthority.close();
    throw new CliInputError(
      "--github-manifest and --github-pilot-output must be supplied together"
    );
  }
  const installedRoot = fileURLToPath(new URL("../", import.meta.url));
  const installedFixtureManifest = join(installedRoot, "fixture", "manifest.json");
  const fixtureManifestPath = existsSync(installedFixtureManifest)
    ? installedFixtureManifest
    : resolve("fixtures/parallelplay-fixture-manifest.json");
  const fixtureManifest = readJsonFile(fixtureManifestPath, "Fixture manifest") as {
    revisions?: { baseline?: unknown; completeTaskCandidate?: unknown };
  };
  const baselineCommit = fixtureManifest.revisions?.baseline;
  const candidateCommit = fixtureManifest.revisions?.completeTaskCandidate;
  if (
    typeof baselineCommit !== "string" ||
    typeof candidateCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(baselineCommit) ||
    !/^[a-f0-9]{40}$/.test(candidateCommit)
  ) {
    outboundAuthority.close();
    throw new CliInputError("Fixture manifest does not bind the two pilot commits");
  }
  const githubManifest = githubManifestPath
    ? ExtensionManifestV1Schema.parse(readJsonFile(resolve(githubManifestPath), "GitHub manifest"))
    : null;
  let server: Awaited<ReturnType<typeof startAttentionServer>>;
  try {
    server = await startAttentionServer({
      databasePath,
      operatorId: option(args, "operator-id"),
      port,
      githubSetup,
      outboundAuthority,
      ...(githubManifest && githubPilotOutput
        ? {
            githubPilot: {
              run: async (policyPromotionDigest: string) => {
                const output = resolve(githubPilotOutput);
                if (existsSync(output)) throw new Error("GitHub pilot evidence already exists");
                let tokenProvider = environmentTokenProvider;
                tokenProvider ??= githubSetup.hostTokenProvider();
                const evidence = await runGitHubFixturePilot({
                  manifest: githubManifest,
                  tokenProvider,
                  authority: outboundAuthority,
                  policyPromotionDigest,
                  baselineCommit,
                  candidateCommit
                });
                mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
                writeFileSync(output, `${JSON.stringify(evidence)}\n`, {
                  mode: 0o600,
                  flag: "wx"
                });
                return evidence;
              }
            }
          }
        : {})
    });
  } catch (error) {
    outboundAuthority.close();
    throw error;
  }
  writeJson(process.stdout, {
    ok: true,
    action: "attention_app_started",
    host: server.host,
    port: server.port,
    bootstrapUrl: server.bootstrapUrl
  });
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve()));
    return 0;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await server.close();
    outboundAuthority.close();
  }
}

async function runAdvisorSupervisor(args: ParsedArguments, once: boolean): Promise<number> {
  const kernel = await openKernel({ databasePath: option(args, "db") });
  try {
    const supervisorId = uuidOption(args, "supervisor-id");
    const supervisor = new AdvisorSupervisor({
      kernel,
      adapter: new ContainedAdvisorDriver({
        ...(args.options.has("docker-binary")
          ? { dockerBinary: option(args, "docker-binary") }
          : {})
      }),
      supervisorId,
      onRecord: (record) =>
        writeJson(record.action === "command_rejected" ? process.stderr : process.stdout, record)
    });
    if (once) {
      const result = await supervisor.tick();
      if (result.action === "idle") writeJson(process.stdout, result);
      return result.action === "command_rejected" ? 3 : 0;
    }
    const abort = new AbortController();
    const stop = (): void => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const maxTicksRaw = args.options.get("max-ticks");
      const ticks = await supervisor.run({
        signal: abort.signal,
        ...(maxTicksRaw === undefined ? {} : { maxTicks: integerOption(args, "max-ticks") })
      });
      writeJson(process.stdout, { action: "advisor_supervisor_stopped", supervisorId, ticks });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await kernel.close();
  }
}

async function dispatch(args: ParsedArguments): Promise<number> {
  const [group, action] = args.positional;
  if (!group || group === "help" || group === "--help") {
    writeJson(process.stdout, help());
    return 0;
  }
  if (group === "id" && action === "new") {
    writeJson(process.stdout, { ok: true, id: randomUUID() });
    return 0;
  }
  if (group === "db" && action === "status") {
    writeJson(process.stdout, { ok: true, ...(await getMigrationStatus(option(args, "db"))) });
    return 0;
  }
  if (group === "db" && action === "migrate") {
    writeJson(process.stdout, {
      ok: true,
      ...(await migrateDatabase({ databasePath: option(args, "db") }))
    });
    return 0;
  }
  if (group === "fake-agent" && action === "status") {
    writeJson(process.stdout, {
      ok: true,
      ...(await getFakeAgentMigrationStatus(option(args, "fake-db")))
    });
    return 0;
  }
  if (group === "fake-agent" && action === "migrate") {
    writeJson(process.stdout, {
      ok: true,
      ...(await migrateFakeAgentDatabase({ databasePath: option(args, "fake-db") }))
    });
    return 0;
  }
  if (group === "source-store" && action === "status") {
    writeJson(process.stdout, { ok: true, ...getSourceStoreStatus(option(args, "source-root")) });
    return 0;
  }
  if (group === "source-store" && action === "init") {
    writeJson(process.stdout, { ok: true, ...initializeSourceStore(option(args, "source-root")) });
    return 0;
  }
  if (group === "artifact-store" && action === "status") {
    writeJson(process.stdout, {
      ok: true,
      ...getArtifactStoreStatus(option(args, "artifact-root"))
    });
    return 0;
  }
  if (group === "artifact-store" && action === "init") {
    writeJson(process.stdout, {
      ok: true,
      ...initializeArtifactStore(option(args, "artifact-root"))
    });
    return 0;
  }
  if (group === "driver-store" && action === "status") {
    writeJson(process.stdout, { ok: true, ...getDriverStoreStatus(option(args, "driver-root")) });
    return 0;
  }
  if (group === "driver-store" && action === "init") {
    writeJson(process.stdout, { ok: true, ...initializeDriverStore(option(args, "driver-root")) });
    return 0;
  }
  if (group === "sandbox" && (action === "status" || action === "preflight")) {
    const image = preparedImage(args);
    const result = await dockerPreflight(image, args.options.get("docker-binary") ?? "docker");
    const valid = result.ok && image !== undefined && result.imageAvailable;
    writeJson(valid ? process.stdout : process.stderr, {
      preparedImage: image ?? null,
      ...result,
      ok: valid,
      ...(!image
        ? { failures: [...result.failures, "Prepared sandbox image is not configured"] }
        : {})
    });
    return valid ? 0 : 3;
  }
  if (group === "supervisor" && action === "once") return runSupervisor(args, true);
  if (group === "supervisor" && action === "run") return runSupervisor(args, false);
  if (group === "integration-supervisor" && action === "once") {
    return runIntegrationSupervisor(args, true);
  }
  if (group === "integration-supervisor" && action === "run") {
    return runIntegrationSupervisor(args, false);
  }
  if (group === "explorer" && action === "serve") return runExplorer(args);
  if (group === "attention-app" && action === "serve") return runAttentionApp(args);
  if (group === "attention-delivery" && action === "once") {
    return runAttentionDelivery(args, true);
  }
  if (group === "attention-delivery" && action === "run") {
    return runAttentionDelivery(args, false);
  }
  if (group === "advisor-supervisor" && action === "once") {
    return runAdvisorSupervisor(args, true);
  }
  if (group === "advisor-supervisor" && action === "run") {
    return runAdvisorSupervisor(args, false);
  }
  if (group === "interview" && action === "guide") return runInterviewGuide(args);

  const db = option(args, "db");
  if (group === "advisor-subject" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-subject.approve",
        payload: { subject: readJsonFile(option(args, "file"), "Advisor subject") }
      })
    );
  }
  if (group === "advisor-subject" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listAdvisorSubjects() });
      return 0;
    });
  }
  if (group === "advisor-subject" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "advisor_subject", id: uuidOption(args, "subject-id") })
      });
      return 0;
    });
  }
  if (group === "advisor-case" && action === "record") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-case.record",
        payload: { case: readJsonFile(option(args, "file"), "Advisor case") }
      })
    );
  }
  if (group === "advisor-case" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorCases(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-case" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "advisor_case", id: uuidOption(args, "case-id") })
      });
      return 0;
    });
  }
  if (group === "advisor-corpus" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-corpus.approve",
        payload: { corpus: readJsonFile(option(args, "file"), "Advisor corpus") }
      })
    );
  }
  if (group === "advisor-corpus" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listAdvisorCorpora() });
      return 0;
    });
  }
  if (group === "advisor-corpus" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_corpus",
          id: uuidOption(args, "corpus-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-contamination" && action === "record") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-contamination.record",
        payload: { contamination: readJsonFile(option(args, "file"), "Advisor contamination") }
      })
    );
  }
  if (group === "advisor-contamination" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listAdvisorContamination() });
      return 0;
    });
  }
  if (group === "advisor-contamination" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_contamination",
          id: uuidOption(args, "contamination-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-invocation" && action === "queue") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "advisor-queue" },
        type: "advisor-invocation.queue",
        payload: readJsonFile(option(args, "file"), "Advisor invocation")
      })
    );
  }
  if (group === "advisor-invocation" && action === "cancel") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-invocation.cancel",
        payload: readJsonFile(option(args, "file"), "Advisor invocation cancellation")
      })
    );
  }
  if (group === "advisor-invocation" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listAdvisorInvocations() });
      return 0;
    });
  }
  if (group === "advisor-invocation" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_invocation",
          id: uuidOption(args, "invocation-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-recommendation" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorRecommendations(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-recommendation" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_recommendation",
          id: uuidOption(args, "recommendation-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-evaluation" && action === "compile") {
    return withKernel(db, async (kernel) => {
      const payload = readJsonFile(option(args, "file"), "Advisor evaluation");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CliInputError("Advisor evaluation file must contain a JSON object");
      }
      return executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "advisor-evaluator" },
        type: "advisor-evaluation.compile",
        payload: { ...payload, expectedThroughPosition: await currentGlobalPosition(kernel) }
      });
    });
  }
  if (group === "advisor-evaluation" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorEvaluations(
          args.options.has("policy-revision-id")
            ? uuidOption(args, "policy-revision-id")
            : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-evaluation" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_evaluation",
          id: uuidOption(args, "report-id")
        })
      });
      return 0;
    });
  }
  if (group === "decision-policy-proposal" && action === "compile") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "policy-proposal-compiler" },
        type: "decision-policy-proposal.compile",
        payload: { proposal: readJsonFile(option(args, "file"), "Decision policy proposal") }
      })
    );
  }
  if (group === "decision-policy-proposal" && action === "close") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "decision-policy-proposal.close",
        payload: readJsonFile(option(args, "file"), "Decision policy proposal closure")
      })
    );
  }
  if (group === "decision-policy-proposal" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listDecisionPolicyProposals() });
      return 0;
    });
  }
  if (group === "decision-policy-proposal" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "decision_policy_proposal",
          id: uuidOption(args, "proposal-id")
        })
      });
      return 0;
    });
  }
  if (group === "decision-policy" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "decision-policy.approve",
        payload: { policy: readJsonFile(option(args, "file"), "Decision policy") }
      })
    );
  }
  if (group === "decision-policy" && action === "suspend") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "decision-policy.suspend",
        payload: readJsonFile(option(args, "file"), "Decision policy suspension")
      })
    );
  }
  if (group === "decision-policy" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listDecisionPolicies() });
      return 0;
    });
  }
  if (group === "decision-policy" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "decision_policy",
          id: uuidOption(args, "policy-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-promotion" && action === "compile") {
    return withKernel(db, async (kernel) => {
      const payload = readJsonFile(option(args, "file"), "Advisor promotion");
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CliInputError("Advisor promotion file must contain a JSON object");
      }
      return executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "advisor-promotion-compiler" },
        type: "advisor-promotion.compile",
        payload: { ...payload, expectedThroughPosition: await currentGlobalPosition(kernel) }
      });
    });
  }
  if (group === "advisor-promotion" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listDecisionPolicyPromotions() });
      return 0;
    });
  }
  if (group === "advisor-promotion" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "decision_policy_promotion",
          id: uuidOption(args, "promotion-id")
        })
      });
      return 0;
    });
  }
  if (group === "decision" && action === "promote-advisor-policy") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "decision.promote-advisor-policy",
        payload: readJsonFile(option(args, "file"), "Advisor promotion decision")
      })
    );
  }
  if (group === "advisor-resolution" && action === "resolve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "advisor-resolver" },
        type: "advisor.resolve",
        payload: readJsonFile(option(args, "file"), "Advisor resolution")
      })
    );
  }
  if (group === "advisor-resolution" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorResolutions(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-resolution" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_resolution",
          id: uuidOption(args, "resolution-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor-audit" && action === "record") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "advisor-audit.record",
        payload: readJsonFile(option(args, "file"), "Advisor audit")
      })
    );
  }
  if (group === "advisor-audit" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorAudits(
          args.options.has("policy-revision-id")
            ? uuidOption(args, "policy-revision-id")
            : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-audit" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "advisor_audit", id: uuidOption(args, "audit-id") })
      });
      return 0;
    });
  }
  if (group === "advisor-incident" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAdvisorIncidents(
          args.options.has("policy-revision-id")
            ? uuidOption(args, "policy-revision-id")
            : undefined
        )
      });
      return 0;
    });
  }
  if (group === "advisor-incident" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "advisor_incident",
          id: uuidOption(args, "incident-id")
        })
      });
      return 0;
    });
  }
  if (group === "advisor" && action === "snapshot") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.getAdvisorSnapshot() });
      return 0;
    });
  }
  if (group === "program" && action === "create") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "program.create",
        payload: { programId: option(args, "program-id"), name: option(args, "name") }
      })
    );
  }
  if (group === "program" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "program.approve",
        payload: readJsonFile(option(args, "file"), "Program approval")
      })
    );
  }
  if (group === "program" && action === "kickoff") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "program.kickoff",
        payload: readJsonFile(option(args, "file"), "Program kickoff")
      })
    );
  }
  if (group === "interview" && action === "capture") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "interview.capture",
        payload: readJsonFile(option(args, "file"), "Interview capture")
      })
    );
  }
  if (group === "program-graph" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "program-graph.approve",
        payload: readJsonFile(option(args, "file"), "Program graph")
      })
    );
  }
  if (group === "program" && action === "start") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "program.start",
        payload: readJsonFile(option(args, "file"), "Program start")
      })
    );
  }
  if (group === "program" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listPrograms() });
      return 0;
    });
  }
  if (group === "program" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "program", id: uuidOption(args, "program-id") })
      });
      return 0;
    });
  }
  if (group === "interview" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listProgramInterviews(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "interview" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "program_interview",
          id: uuidOption(args, "interview-id")
        })
      });
      return 0;
    });
  }
  if (group === "program-graph" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listProgramGraphs(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "program-graph" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "program_graph",
          id: uuidOption(args, "graph-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "generation" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listMilestoneGenerations(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "generation" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "milestone_generation",
          id: uuidOption(args, "generation-id")
        })
      });
      return 0;
    });
  }
  if (group === "context" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listContextPackets(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "context" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "context_packet",
          id: uuidOption(args, "context-packet-id")
        })
      });
      return 0;
    });
  }
  if (group === "revision" && action === "capture") {
    return withKernel(db, async (kernel) => {
      const revisionId = uuidOption(args, "revision-id");
      const store = new ManagedGitRevisionStore(option(args, "source-root"));
      const captured = await store.capture({
        repositoryId: uuidOption(args, "repository-id"),
        revisionId,
        captureKey: option(args, "idempotency-key"),
        repositoryPath: option(args, "repo"),
        ref: option(args, "ref")
      });
      return executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "source-revision.register",
        payload: captured
      });
    });
  }
  if (group === "revision" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listSourceRevisions() });
      return 0;
    });
  }
  if (group === "revision" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "source_revision", id: option(args, "revision-id") })
      });
      return 0;
    });
  }
  if (group === "workflow" && action === "register") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "workflow.register",
        payload: readJsonFile(option(args, "file"), "Workflow")
      })
    );
  }
  if (group === "run" && action === "create") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "run.create",
        payload: {
          runId: option(args, "run-id"),
          programId: option(args, "program-id"),
          workflowId: option(args, "workflow-id"),
          workflowVersion: integerOption(args, "workflow-version")
        }
      })
    );
  }
  if (group === "run" && action === "schedule") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "run.schedule",
        payload: readJsonFile(option(args, "file"), "Schedule manifest")
      })
    );
  }
  if (group === "run" && action === "cancel") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "run.cancel",
        payload: { runId: option(args, "run-id"), reason: option(args, "reason") }
      })
    );
  }
  if (group === "milestone" && action === "start") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "milestone.start",
        payload: readJsonFile(option(args, "file"), "Milestone start")
      })
    );
  }
  if (group === "milestone" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listMilestones(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "milestone" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "milestone", id: uuidOption(args, "milestone-id") })
      });
      return 0;
    });
  }
  if (group === "outcome-packet" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listOutcomePackets(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "outcome-packet" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "outcome_packet",
          id: uuidOption(args, "outcome-packet-id")
        })
      });
      return 0;
    });
  }
  if (group === "outcome-packet" && action === "verify") {
    return withKernel(db, async (kernel) => {
      const result = await kernel.verifyOutcomePacket(uuidOption(args, "outcome-packet-id"));
      writeJson(result.valid ? process.stdout : process.stderr, { ok: result.valid, ...result });
      return result.valid ? 0 : 3;
    });
  }
  if (group === "outcome-packet" && action === "disposition") {
    if (args.flags.has("accepted") === args.flags.has("rejected")) {
      throw new CliInputError("Specify exactly one of --accepted or --rejected");
    }
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "outcome-packet.disposition",
        payload: {
          schemaVersion: 1,
          outcomePacketId: uuidOption(args, "outcome-packet-id"),
          disposition: args.flags.has("accepted") ? "accepted" : "rejected",
          reason: args.options.get("reason") ?? null
        }
      })
    );
  }
  if (group === "outcome-validation" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listOutcomeValidations(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "outcome-validation" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "outcome_validation",
          id: uuidOption(args, "validation-id")
        })
      });
      return 0;
    });
  }
  if (group === "issue" && action === "raise") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        ...commandEnvelope(args),
        type: "issue.raise",
        payload: readJsonFile(option(args, "file"), "Routed issue")
      })
    );
  }
  if (group === "issue" && action === "resolve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "issue.resolve",
        payload: readJsonFile(option(args, "file"), "Issue resolution")
      })
    );
  }
  if (group === "issue" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listRoutedIssues(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "issue" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "routed_issue", id: uuidOption(args, "issue-id") })
      });
      return 0;
    });
  }
  if (group === "attention" && action === "start") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "attention.start",
        payload: {
          schemaVersion: 1,
          attentionSpanId: uuidOption(args, "attention-span-id"),
          programId: uuidOption(args, "program-id"),
          label: option(args, "label")
        }
      })
    );
  }
  if (group === "attention" && action === "stop") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "attention.stop",
        payload: {
          schemaVersion: 1,
          attentionSpanId: uuidOption(args, "attention-span-id")
        }
      })
    );
  }
  if (group === "attention" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAttentionSpans(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_span",
          id: uuidOption(args, "attention-span-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-policy" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "attention-policy.approve",
        payload: { policy: readJsonFile(option(args, "file"), "Attention policy") }
      })
    );
  }
  if (group === "attention-policy" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listAttentionPolicies() });
      return 0;
    });
  }
  if (group === "attention-policy" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_policy",
          id: uuidOption(args, "policy-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "portfolio-policy" && action === "approve") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "portfolio-policy.approve",
        payload: { policy: readJsonFile(option(args, "file"), "Portfolio policy") }
      })
    );
  }
  if (group === "portfolio-policy" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listPortfolioPolicies() });
      return 0;
    });
  }
  if (group === "portfolio-policy" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "portfolio_policy",
          id: uuidOption(args, "policy-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "integration-target" && action === "approve") {
    return withKernel(db, async (kernel) => {
      const target = IntegrationTargetInputV1Schema.parse(
        readJsonFile(option(args, "file"), "Integration target")
      );
      const initialHead = await kernel.getState({
        kind: "source_revision",
        id: target.initialHeadRef.id
      });
      if (
        initialHead?.kind !== "source_revision" ||
        initialHead.revisionDigest !== target.initialHeadRef.digest
      ) {
        throw new CliInputError("Integration target initial head is missing or stale");
      }
      const managedRef = await new ManagedGitRevisionStore(
        option(args, "source-root")
      ).initializeIntegrationRef(target.targetId, initialHead);
      if (managedRef !== target.managedRef) {
        throw new CliInputError("Integration target managed ref is not derived from its target ID");
      }
      return executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "integration-target.approve",
        payload: { target }
      });
    });
  }
  if (group === "integration-target" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listIntegrationTargets() });
      return 0;
    });
  }
  if (group === "integration-target" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "integration_target",
          id: uuidOption(args, "target-revision-id")
        })
      });
      return 0;
    });
  }
  if (group === "decision" && action === "request") {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "decision.request",
        payload: { request: readJsonFile(option(args, "file"), "Decision request") }
      })
    );
  }
  if (group === "decision" && action === "compile") {
    return withKernel(db, async (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "system", id: args.options.get("actor-id") ?? "attention-compiler" },
        type: "attention.compile",
        payload: {
          schemaVersion: 1,
          source: readJsonFile(option(args, "file"), "Attention source"),
          expectedThroughPosition: await currentGlobalPosition(kernel)
        }
      })
    );
  }
  if (
    group === "decision" &&
    (action === "acknowledge" ||
      action === "approve" ||
      action === "retry" ||
      action === "cancel" ||
      action === "park" ||
      action === "reprioritize" ||
      action === "integrate")
  ) {
    return withKernel(db, (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: action === "acknowledge" ? "decision.acknowledge" : `decision.${action}`,
        payload: readJsonFile(option(args, "file"), `Decision ${action}`)
      })
    );
  }
  if (group === "decision" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listDecisionPackets(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "decision" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "decision_packet", id: uuidOption(args, "packet-id") })
      });
      return 0;
    });
  }
  if (group === "decision" && action === "revisions") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listDecisionPacketRevisions(uuidOption(args, "packet-id"))
      });
      return 0;
    });
  }
  if (group === "decision" && action === "audit") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getDecisionAudit(uuidOption(args, "packet-id"))
      });
      return 0;
    });
  }
  if (group === "attention-queue" && (action === "list" || action === "snapshot")) {
    return withKernel(db, async (kernel) => {
      const programId = args.options.has("program-id") ? uuidOption(args, "program-id") : undefined;
      if (action === "snapshot") {
        writeJson(process.stdout, { ok: true, data: await kernel.getAttentionSnapshot(programId) });
      } else {
        const route = args.options.get("route");
        if (route !== undefined && route !== "queue" && route !== "page") {
          throw new CliInputError("--route must be queue or page");
        }
        writeJson(process.stdout, {
          ok: true,
          data: await kernel.listAttentionQueue(programId, route)
        });
      }
      return 0;
    });
  }
  if (group === "attention-evidence" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listDecisionEvidenceBundles(
          args.options.has("packet-id") ? uuidOption(args, "packet-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-evidence" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "decision_evidence_bundle",
          id: uuidOption(args, "evidence-bundle-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-precedent" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listDecisionPrecedents(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-precedent" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "decision_precedent",
          id: uuidOption(args, "precedent-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-delivery" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAttentionDeliveries(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-delivery" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_delivery",
          id: uuidOption(args, "delivery-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-budget" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAttentionBudgetIncidents(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-budget" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_budget_incident",
          id: uuidOption(args, "incident-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-measurement-report" && action === "compile") {
    return withKernel(db, async (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "attention-measurement-report.compile",
        payload: {
          schemaVersion: 1,
          reportId: uuidOption(args, "report-id"),
          programId: uuidOption(args, "program-id"),
          expectedThroughPosition: await currentGlobalPosition(kernel)
        }
      })
    );
  }
  if (group === "attention-measurement-report" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAttentionMeasurementReports(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-measurement-report" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_measurement_report",
          id: uuidOption(args, "report-id")
        })
      });
      return 0;
    });
  }
  if (group === "attention-digest" && action === "compile") {
    return withKernel(db, async (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "attention-digest.compile",
        payload: {
          schemaVersion: 1,
          artifactId: uuidOption(args, "artifact-id"),
          programId: uuidOption(args, "program-id"),
          expectedThroughPosition: await currentGlobalPosition(kernel)
        }
      })
    );
  }
  if (group === "attention-digest" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listAttentionDigestArtifacts(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "attention-digest" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "attention_digest_artifact",
          id: uuidOption(args, "artifact-id")
        })
      });
      return 0;
    });
  }
  if (group === "outcome-disposition" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listOutcomeDispositions(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "outcome-disposition" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "outcome_disposition",
          id: uuidOption(args, "outcome-packet-id")
        })
      });
      return 0;
    });
  }
  if (group === "measurement-report" && action === "compile") {
    return withKernel(db, async (kernel) =>
      executeCommand(kernel, {
        idempotencyKey: option(args, "idempotency-key"),
        actor: { kind: "operator", id: option(args, "actor-id") },
        type: "measurement-report.compile",
        payload: {
          schemaVersion: 1,
          reportId: uuidOption(args, "report-id"),
          programId: uuidOption(args, "program-id"),
          expectedThroughPosition: await currentGlobalPosition(kernel)
        }
      })
    );
  }
  if (group === "measurement-report" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listMeasurementReports(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "measurement-report" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "measurement_report",
          id: uuidOption(args, "report-id")
        })
      });
      return 0;
    });
  }
  if (group === "task-projection" && action === "render") {
    return withKernel(db, async (kernel) => {
      const result = renderTaskProjection({
        outputRoot: option(args, "output-root"),
        programs: await kernel.listPrograms(),
        milestones: await kernel.listMilestones(),
        outcomePackets: await kernel.listOutcomePackets()
      });
      writeJson(process.stdout, { ok: true, ...result });
      return 0;
    });
  }
  if (group === "portfolio" && action === "snapshot") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.getPortfolioSnapshot() });
      return 0;
    });
  }
  if (group === "admission" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listPortfolioAdmissions(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "admission" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "portfolio_admission",
          id: uuidOption(args, "admission-id")
        })
      });
      return 0;
    });
  }
  if (group === "lease" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listConcurrencyLeases(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "lease" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "concurrency_lease",
          id: uuidOption(args, "lease-id")
        })
      });
      return 0;
    });
  }
  if (group === "candidate-diff" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listCandidateDiffManifests(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "candidate-diff" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "candidate_diff_manifest",
          id: uuidOption(args, "manifest-id")
        })
      });
      return 0;
    });
  }
  if (group === "integration-candidate" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listIntegrationCandidates(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "integration-candidate" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "integration_candidate",
          id: uuidOption(args, "candidate-id")
        })
      });
      return 0;
    });
  }
  if (group === "integration-work" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listIntegrationWork() });
      return 0;
    });
  }
  if (group === "integration-work" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "integration_work", id: uuidOption(args, "work-id") })
      });
      return 0;
    });
  }
  if (group === "integration-conflict" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listIntegrationConflicts() });
      return 0;
    });
  }
  if (group === "integration-conflict" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "integration_conflict",
          id: uuidOption(args, "conflict-id")
        })
      });
      return 0;
    });
  }
  if (group === "integration-verification" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listIntegrationVerifications() });
      return 0;
    });
  }
  if (group === "integration-verification" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "integration_verification",
          id: uuidOption(args, "verification-id")
        })
      });
      return 0;
    });
  }
  if (group === "promotion-receipt" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listPromotionReceipts(
          args.options.has("program-id") ? uuidOption(args, "program-id") : undefined
        )
      });
      return 0;
    });
  }
  if (group === "promotion-receipt" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "promotion_receipt",
          id: uuidOption(args, "receipt-id")
        })
      });
      return 0;
    });
  }
  if (group === "portfolio-slo" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listPortfolioSloIncidents() });
      return 0;
    });
  }
  if (group === "portfolio-slo" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "portfolio_slo_incident",
          id: uuidOption(args, "incident-id")
        })
      });
      return 0;
    });
  }
  if (group === "portfolio-report" && action === "compile") {
    return withKernel(db, async (kernel) => {
      const result = await kernel.compilePortfolioMeasurementReport(uuidOption(args, "report-id"));
      writeJson(result.ok ? process.stdout : process.stderr, result);
      return result.ok ? 0 : 3;
    });
  }
  if (group === "portfolio-report" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, data: await kernel.listPortfolioMeasurementReports() });
      return 0;
    });
  }
  if (group === "portfolio-report" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "portfolio_measurement_report",
          id: uuidOption(args, "report-id")
        })
      });
      return 0;
    });
  }
  if (group === "state" && action === "show") {
    return withKernel(db, async (kernel) => {
      const kind = option(args, "kind");
      const id = option(args, "id");
      if (kind === "workflow") {
        writeJson(process.stdout, {
          ok: true,
          data: await kernel.getState({ kind, id, version: integerOption(args, "version") })
        });
      } else if (
        kind === "program" ||
        kind === "program_interview" ||
        kind === "program_graph" ||
        kind === "milestone" ||
        kind === "milestone_generation" ||
        kind === "context_packet" ||
        kind === "outcome_packet" ||
        kind === "outcome_validation" ||
        kind === "routed_issue" ||
        kind === "attention_span" ||
        kind === "outcome_disposition" ||
        kind === "measurement_report" ||
        kind === "operator_decision_request" ||
        kind === "decision_packet" ||
        kind === "decision_packet_revision" ||
        kind === "decision_evidence_bundle" ||
        kind === "attention_policy" ||
        kind === "decision_acknowledgement" ||
        kind === "decision_resolution" ||
        kind === "decision_action_result" ||
        kind === "decision_precedent" ||
        kind === "attention_delivery" ||
        kind === "attention_budget_incident" ||
        kind === "attention_measurement_report" ||
        kind === "attention_digest_artifact" ||
        kind === "portfolio_policy" ||
        kind === "integration_target" ||
        kind === "portfolio_admission" ||
        kind === "concurrency_lease" ||
        kind === "candidate_diff_manifest" ||
        kind === "integration_candidate" ||
        kind === "integration_work" ||
        kind === "integration_conflict" ||
        kind === "integration_verification" ||
        kind === "promotion_receipt" ||
        kind === "portfolio_slo_incident" ||
        kind === "portfolio_measurement_report" ||
        kind === "advisor_subject" ||
        kind === "advisor_case" ||
        kind === "advisor_corpus" ||
        kind === "advisor_contamination" ||
        kind === "advisor_invocation" ||
        kind === "advisor_recommendation" ||
        kind === "advisor_evaluation" ||
        kind === "decision_policy_proposal" ||
        kind === "decision_policy" ||
        kind === "decision_policy_promotion" ||
        kind === "advisor_resolution" ||
        kind === "advisor_audit" ||
        kind === "advisor_incident" ||
        kind === "run" ||
        kind === "attempt" ||
        kind === "job" ||
        kind === "outbox" ||
        kind === "source_revision" ||
        kind === "artifact_manifest" ||
        kind === "verification" ||
        kind === "driver_receipt" ||
        kind === "approval_request"
      ) {
        writeJson(process.stdout, {
          ok: true,
          data: await kernel.getState({ kind, id } as StateReference)
        });
      } else {
        throw new CliInputError("--kind is not a supported state kind");
      }
      return 0;
    });
  }
  if (group === "job" && action === "list") {
    return withKernel(db, async (kernel) => {
      const status = statusOption(args, jobStatuses);
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listJobs({
          ...(args.options.get("run-id") ? { runId: option(args, "run-id") } : {}),
          ...(status ? { statuses: [status] } : {})
        })
      });
      return 0;
    });
  }
  if (group === "job" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "job", id: option(args, "job-id") })
      });
      return 0;
    });
  }
  if (group === "outbox" && action === "list") {
    return withKernel(db, async (kernel) => {
      const status = statusOption(args, outboxStatuses);
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listOutbox({
          ...(args.options.get("run-id") ? { runId: option(args, "run-id") } : {}),
          ...(status ? { statuses: [status] } : {})
        })
      });
      return 0;
    });
  }
  if (group === "outbox" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({ kind: "outbox", id: option(args, "outbox-id") })
      });
      return 0;
    });
  }
  if (group === "artifact" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listArtifactManifests({
          ...(args.options.get("run-id") ? { runId: option(args, "run-id") } : {})
        })
      });
      return 0;
    });
  }
  if (group === "artifact" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "artifact_manifest",
          id: option(args, "artifact-manifest-id")
        })
      });
      return 0;
    });
  }
  if (group === "artifact" && action === "verify") {
    return withKernel(db, async (kernel) => {
      const artifactManifestId = option(args, "artifact-manifest-id");
      const manifest = await kernel.getState({
        kind: "artifact_manifest",
        id: artifactManifestId
      });
      if (manifest?.kind !== "artifact_manifest") {
        writeJson(process.stderr, {
          ok: false,
          artifactManifestId,
          failures: ["artifact manifest missing"]
        });
        return 3;
      }
      const objectIntegrity = new FileArtifactStore(option(args, "artifact-root")).verify(
        manifest.entries
      );
      const failures = [...objectIntegrity.failures];
      if (artifactManifestDigest(manifest.entries) !== manifest.manifestDigest) {
        failures.push("artifact manifest digest mismatch");
      }
      writeJson(failures.length === 0 ? process.stdout : process.stderr, {
        ok: failures.length === 0,
        artifactManifestId,
        failures
      });
      return failures.length === 0 ? 0 : 3;
    });
  }
  if (group === "verification" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listVerifications({
          ...(args.options.get("run-id") ? { runId: option(args, "run-id") } : {})
        })
      });
      return 0;
    });
  }
  if (group === "verification" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "verification",
          id: option(args, "verification-id")
        })
      });
      return 0;
    });
  }
  if (group === "verification" && action === "verify") {
    return withKernel(db, async (kernel) => {
      const result = await verifyEvidence({
        kernel,
        sourceStore: new ManagedGitRevisionStore(option(args, "source-root")),
        artifactStore: new FileArtifactStore(option(args, "artifact-root")),
        verificationId: option(args, "verification-id")
      });
      writeJson(result.valid ? process.stdout : process.stderr, { ok: result.valid, ...result });
      return result.valid ? 0 : 3;
    });
  }
  if (group === "driver-receipt" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listDriverReceipts({
          ...(args.options.get("run-id") ? { runId: uuidOption(args, "run-id") } : {})
        })
      });
      return 0;
    });
  }
  if (group === "driver-receipt" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "driver_receipt",
          id: uuidOption(args, "driver-receipt-id")
        })
      });
      return 0;
    });
  }
  if (group === "approval-request" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.listApprovalRequests({
          ...(args.options.get("run-id") ? { runId: uuidOption(args, "run-id") } : {})
        })
      });
      return 0;
    });
  }
  if (group === "approval-request" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getState({
          kind: "approval_request",
          id: uuidOption(args, "approval-request-id")
        })
      });
      return 0;
    });
  }
  if (group === "evidence" && action === "verify") {
    return withKernel(db, async (kernel) => {
      const result = await verifyDriverEvidence({
        kernel,
        sourceStore: new ManagedGitRevisionStore(option(args, "source-root")),
        artifactStore: new FileArtifactStore(option(args, "artifact-root")),
        driverReceiptId: uuidOption(args, "driver-receipt-id")
      });
      writeJson(result.valid ? process.stdout : process.stderr, { ok: result.valid, ...result });
      return result.valid ? 0 : 3;
    });
  }
  if (group === "events" && action === "list") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        ...(await kernel.listEvents({
          afterPosition: integerOption(args, "after", 0),
          limit: integerOption(args, "limit", 100)
        }))
      });
      return 0;
    });
  }
  if (group === "trace" && action === "show") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, {
        ok: true,
        data: await kernel.getExecutionTrace(option(args, "run-id"))
      });
      return 0;
    });
  }
  if (group === "projection" && action === "verify") {
    return withKernel(db, async (kernel) => {
      const result = await kernel.verifyProjections();
      writeJson(result.valid ? process.stdout : process.stderr, { ok: result.valid, ...result });
      return result.valid ? 0 : 3;
    });
  }
  if (group === "projection" && action === "rebuild") {
    return withKernel(db, async (kernel) => {
      writeJson(process.stdout, { ok: true, ...(await kernel.rebuildProjections()) });
      return 0;
    });
  }
  throw new CliInputError("Unknown command");
}

export async function run(argv: string[]): Promise<number> {
  try {
    return await dispatch(parseArguments(argv));
  } catch (error) {
    if (error instanceof CliInputError) {
      writeJson(process.stderr, {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: error.message }
      });
      return 2;
    }
    if (error instanceof KernelSetupError) {
      writeJson(process.stderr, {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details ?? null }
      });
      return 3;
    }
    writeJson(process.stderr, {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unexpected error"
      }
    });
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await run(process.argv.slice(2));
}
