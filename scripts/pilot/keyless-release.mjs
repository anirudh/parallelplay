#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Usage: keyless-release.mjs --cli <path> --fixture <path> --output <path>");
    }
    result.set(key.slice(2), value);
  }
  return result;
}

const args = parseArguments(process.argv.slice(2));
const cli = resolve(args.get("cli") ?? "");
const fixture = resolve(args.get("fixture") ?? "");
const output = resolve(args.get("output") ?? "");
if (!cli || !fixture || !output) throw new Error("CLI, fixture, and output are required");

const startedAt = Date.now();
const root = mkdtempSync(join(tmpdir(), "parallelplay-keyless-pilot-"));
const database = join(root, "parallelplay.db");
const sourceRoot = join(root, "source-store");
const artifactRoot = join(root, "artifact-store");
const driverRoot = join(root, "driver-store");
const fakeDatabase = join(root, "fake-agent.db");
const firstProjection = join(root, "projection-before");
const secondProjection = join(root, "projection-after");
const imageFile = join(root, "fixture-image");
const inputDirectory = join(root, "input");
mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });

const ids = {
  repository: "70000000-0000-4000-8000-000000000001",
  revision: "70000000-0000-4000-8000-000000000002",
  workflow: "70000000-0000-4000-8000-000000000003",
  program: "70000000-0000-4000-8000-000000000004",
  interview: "70000000-0000-4000-8000-000000000005",
  playback: "70000000-0000-4000-8000-000000000006",
  graph: "70000000-0000-4000-8000-000000000007",
  milestoneOne: "70000000-0000-4000-8000-000000000008",
  milestoneTwo: "70000000-0000-4000-8000-000000000009",
  context: "70000000-0000-4000-8000-000000000010",
  supervisor: "70000000-0000-4000-8000-000000000011"
};

function command(values, label = values.slice(0, 2).join(" ")) {
  const result = spawnSync(cli, values, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  const line = lines.at(-1);
  if (result.status !== 0) {
    let code = "unknown_error";
    const failureLines = [...lines, ...(result.stderr ?? "").trim().split("\n").filter(Boolean)];
    for (const candidate of failureLines.reverse()) {
      try {
        const failure = JSON.parse(candidate);
        if (typeof failure?.error?.code === "string") {
          code = failure.error.code;
          break;
        }
      } catch {
        // Pilot failures retain only a bounded machine code, never command output.
      }
    }
    throw new Error(`${label} failed with status ${String(result.status)} (${code})`);
  }
  if (!line) throw new Error(`${label} returned no result`);
  return JSON.parse(line);
}

function writeInput(name, value) {
  const path = join(inputDirectory, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function directoryDigest(directory) {
  const entries = [];
  function visit(current, prefix = "") {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const local = prefix ? `${prefix}/${item.name}` : item.name;
      const absolute = join(current, item.name);
      if (item.isDirectory()) visit(absolute, local);
      else if (item.isFile()) entries.push({ path: local, sha256: sha256(readFileSync(absolute)) });
    }
  }
  visit(directory);
  return sha256(canonical(entries));
}

async function startServer(values) {
  const child = spawn(cli, values, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  const metadata = await new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timer = setTimeout(() => rejectPromise(new Error("UI server start timed out")), 10_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolvePromise(JSON.parse(buffer.slice(0, newline)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`UI server exited before start (${String(code)})`));
    });
  });
  return { child, metadata };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill("SIGTERM");
  await stopped;
}

try {
  const fixtureCommit = spawnSync("git", ["-C", fixture, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(fixtureCommit)) throw new Error("Fixture has no exact Git commit");
  const fixtureStatus = spawnSync("git", ["-C", fixture, "status", "--porcelain"], {
    encoding: "utf8"
  });
  if (fixtureStatus.status !== 0 || fixtureStatus.stdout.trim() !== "") {
    throw new Error("Fixture checkout must be clean before release evidence is generated");
  }
  const build = spawnSync(
    "docker",
    [
      "build",
      "--pull=false",
      "--iidfile",
      imageFile,
      "--tag",
      "parallelplay-keyless-pilot",
      fixture
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (build.status !== 0) throw new Error("Credential-free fixture image build failed");
  const image = readFileSync(imageFile, "utf8").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Fixture image is not digest-bound");

  command(["db", "migrate", "--db", database]);
  command(["fake-agent", "migrate", "--fake-db", fakeDatabase]);
  command(["source-store", "init", "--source-root", sourceRoot]);
  command(["artifact-store", "init", "--artifact-root", artifactRoot]);
  command(["driver-store", "init", "--driver-root", driverRoot]);
  command([
    "revision",
    "capture",
    "--db",
    database,
    "--source-root",
    sourceRoot,
    "--repository-id",
    ids.repository,
    "--revision-id",
    ids.revision,
    "--repo",
    fixture,
    "--ref",
    fixtureCommit,
    "--idempotency-key",
    "pilot-revision"
  ]);
  const revision = command([
    "revision",
    "show",
    "--db",
    database,
    "--revision-id",
    ids.revision
  ]).data;
  if (!revision?.revisionDigest) throw new Error("Captured revision has no digest");

  const workflowPath = writeInput("workflow.json", {
    schemaVersion: 3,
    workflowId: ids.workflow,
    version: 1,
    name: "Public keyless fixture workflow",
    steps: [
      {
        id: "execute",
        capability: "implementation",
        dependsOn: [],
        execution: {
          protocolVersion: 2,
          image,
          argv: ["/bin/sh", "/protocol/success-v2.sh"],
          workingDirectory: "/workspace",
          context: { target: "/context/context.json" }
        },
        capabilities: {
          schemaVersion: 2,
          workspace: "read_write",
          artifactOutput: "read_write",
          scratch: "read_write",
          context: { access: "read_only" },
          cpuLimit: 1,
          memoryLimitBytes: 268435456,
          pidsLimit: 64,
          network: [],
          secrets: [],
          git: []
        },
        verification: {
          mode: "verify",
          argv: ["/bin/sh", "-c", "grep -q 'parallelplay candidate' README.md"],
          cwd: ".",
          timeoutMs: 30_000,
          environment: {},
          toolProbes: []
        }
      }
    ]
  });
  command([
    "workflow",
    "register",
    "--db",
    database,
    "--file",
    workflowPath,
    "--idempotency-key",
    "pilot-workflow"
  ]);
  command([
    "program",
    "kickoff",
    "--db",
    database,
    "--file",
    writeInput("kickoff.json", {
      schemaVersion: 1,
      programId: ids.program,
      name: "Public keyless two-milestone program",
      initialSourceRevisionId: ids.revision,
      initialSourceRevisionDigest: revision.revisionDigest
    }),
    "--idempotency-key",
    "pilot-kickoff"
  ]);
  const transcript = [
    ["objective", "Complete a deterministic two-milestone program."],
    ["desired", "Advance only after verified evidence."],
    ["non-goals", "Never merge or publish."],
    ["edge", "Recover safely from retries."],
    ["owner", "The operator owns outcome acceptance."],
    ["success", "Produce two verified candidate revisions."],
    ["risk", "Use the low-risk local fixture only."],
    ["tenets", "Replay, evidence, and bounded authority."]
  ].map(([questionId, answer]) => ({ questionId, question: questionId, answer }));
  command([
    "interview",
    "capture",
    "--db",
    database,
    "--file",
    writeInput("interview.json", {
      schemaVersion: 1,
      interviewId: ids.interview,
      playbackId: ids.playback,
      programId: ids.program,
      transcript,
      answers: {
        objective: "Complete a deterministic two-milestone program.",
        desiredBehaviors: ["Advance only after verified evidence."],
        nonGoals: ["Never merge or publish."],
        edgeCases: ["Recover safely from retries."],
        ownershipBoundaries: ["The operator owns outcome acceptance."],
        successMeasures: ["Produce two verified candidate revisions."],
        riskTolerance: "low",
        tenets: ["Replay", "Evidence", "Bounded authority"]
      }
    }),
    "--idempotency-key",
    "pilot-interview"
  ]);
  const interview = command([
    "interview",
    "show",
    "--db",
    database,
    "--interview-id",
    ids.interview
  ]).data;
  if (!interview?.playbackDigest) throw new Error("Interview playback has no digest");
  const milestone = (milestoneId, title, dependency, predecessor) => ({
    contract: {
      schemaVersion: 1,
      milestoneId,
      title,
      objective: `${title} in the public fixture.`,
      taskType: "feature",
      priority: "p1",
      tags: ["public-pilot"],
      workflowId: ids.workflow,
      workflowVersion: 1,
      criteria: [
        {
          criterionId: `criterion-${milestoneId.slice(-1)}`,
          statement: "The exact candidate passes deterministic verification.",
          verificationStepId: "execute"
        }
      ]
    },
    dependencies: dependency ? [dependency] : [],
    sourcePredecessorMilestoneId: predecessor,
    allowedWorkSurfaces: ["README.md"],
    refs: []
  });
  command([
    "program-graph",
    "approve",
    "--db",
    database,
    "--file",
    writeInput("graph.json", {
      schemaVersion: 1,
      graphRevisionId: ids.graph,
      programId: ids.program,
      revision: 1,
      priorGraphRef: null,
      intentPlaybackRef: {
        kind: "intent_playback",
        id: ids.playback,
        digest: interview.playbackDigest
      },
      initialSourceRef: {
        kind: "source_revision",
        id: ids.revision,
        digest: revision.revisionDigest
      },
      milestones: [
        milestone(ids.milestoneOne, "Baseline service", null, null),
        milestone(ids.milestoneTwo, "Completion evidence", ids.milestoneOne, ids.milestoneOne)
      ],
      initialContext: {
        decisions: [
          {
            entryId: ids.context,
            scope: { kind: "program" },
            text: "Use one serial, verified source lineage.",
            refs: []
          }
        ],
        assumptions: [],
        risks: [],
        unresolvedQuestions: [],
        refs: [{ kind: "source_revision", id: ids.revision, digest: revision.revisionDigest }]
      }
    }),
    "--actor-id",
    "pilot-operator",
    "--idempotency-key",
    "pilot-graph"
  ]);
  const graph = command([
    "program-graph",
    "show",
    "--db",
    database,
    "--graph-revision-id",
    ids.graph
  ]).data;
  if (!graph?.graphDigest) throw new Error("Approved graph has no digest");
  command([
    "program",
    "start",
    "--db",
    database,
    "--file",
    writeInput("start.json", {
      schemaVersion: 1,
      programId: ids.program,
      graphRevisionId: ids.graph,
      graphDigest: graph.graphDigest,
      policy: { maxAttempts: 1, attemptTimeoutMs: 120_000, retryDelaysMs: [] }
    }),
    "--actor-id",
    "pilot-operator",
    "--idempotency-key",
    "pilot-start"
  ]);
  let completed = false;
  for (let tick = 0; tick < 400; tick += 1) {
    command([
      "supervisor",
      "once",
      "--db",
      database,
      "--fake-db",
      fakeDatabase,
      "--driver-root",
      driverRoot,
      "--source-root",
      sourceRoot,
      "--artifact-root",
      artifactRoot,
      "--supervisor-id",
      ids.supervisor
    ]);
    const program = command([
      "program",
      "show",
      "--db",
      database,
      "--program-id",
      ids.program
    ]).data;
    if (program?.phase === "completed") {
      completed = true;
      break;
    }
  }
  if (!completed) throw new Error("Two-milestone program did not complete");
  const outcomes = command([
    "outcome-packet",
    "list",
    "--db",
    database,
    "--program-id",
    ids.program
  ]).data;
  if (!Array.isArray(outcomes) || outcomes.length !== 2) {
    throw new Error("Pilot did not produce exactly two outcome packets");
  }
  for (const outcome of outcomes) {
    const verified = command([
      "outcome-packet",
      "verify",
      "--db",
      database,
      "--outcome-packet-id",
      outcome.outcomePacketId
    ]);
    if (!verified.valid) throw new Error("Outcome packet verification failed");
  }
  command(["task-projection", "render", "--db", database, "--output-root", firstProjection]);
  const projectionDigestBefore = directoryDigest(firstProjection);
  const snapshotBefore = command(["portfolio", "snapshot", "--db", database]).data;
  const projectionVerification = command(["projection", "verify", "--db", database]);
  if (!projectionVerification.ok) throw new Error("Projection verification failed");
  command(["projection", "rebuild", "--db", database]);
  const snapshotAfter = command(["portfolio", "snapshot", "--db", database]).data;
  command(["task-projection", "render", "--db", database, "--output-root", secondProjection]);
  const projectionDigestAfter = directoryDigest(secondProjection);
  if (
    canonical(snapshotBefore) !== canonical(snapshotAfter) ||
    projectionDigestBefore !== projectionDigestAfter
  ) {
    throw new Error("Projection rebuild changed a public view");
  }

  const explorer = await startServer([
    "explorer",
    "serve",
    "--db",
    database,
    "--source-root",
    sourceRoot,
    "--artifact-root",
    artifactRoot,
    "--port",
    "0"
  ]);
  const attention = await startServer([
    "attention-app",
    "serve",
    "--db",
    database,
    "--operator-id",
    "pilot-operator",
    "--port",
    "0"
  ]);
  try {
    const explorerResponse = await fetch(explorer.metadata.url);
    if (!explorerResponse.ok || !(await explorerResponse.text()).includes("ParallelPlay")) {
      throw new Error("Explorer did not render the shared shell");
    }
    const bootstrap = new URL(attention.metadata.bootstrapUrl);
    const token = new URLSearchParams(bootstrap.hash.slice(1)).get("bootstrap");
    const bootstrapResponse = await fetch(`${bootstrap.origin}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: bootstrap.origin },
      body: JSON.stringify({ token })
    });
    const cookie = bootstrapResponse.headers.get("set-cookie")?.split(";", 1)[0];
    if (!bootstrapResponse.ok || !cookie) throw new Error("Attention bootstrap failed");
    const attentionResponse = await fetch(bootstrap.origin, { headers: { cookie } });
    if (!attentionResponse.ok || !(await attentionResponse.text()).includes("ParallelPlay")) {
      throw new Error("Attention did not render the shared shell");
    }
  } finally {
    await Promise.all([stopServer(explorer.child), stopServer(attention.child)]);
  }

  const evidence = {
    schemaVersion: 1,
    fixtureCommit,
    fixtureImageDigest: image.slice(7),
    graphDigest: graph.graphDigest,
    outcomePacketDigests: outcomes.map((entry) => entry.packetDigest).sort(),
    outcomePackets: outcomes.length,
    projectionDigest: projectionDigestAfter,
    projectionRebuildByteIdentical: true,
    explorerRendered: true,
    attentionRendered: true,
    credentialsRequired: false,
    durationMs: Date.now() - startedAt
  };
  mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${canonical(evidence)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify({ ok: true, evidence: basename(output) })}\n`);
} finally {
  try {
    spawnSync("docker", ["image", "rm", "--force", "parallelplay-keyless-pilot"], {
      stdio: "ignore"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
