import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CONFORMANCE_REQUIREMENTS_V1,
  runConformanceHarness,
  writeConformanceOutputs
} from "../../packages/conformance/dist/index.js";
import {
  GenericSafetyPolicy,
  GenericSoftwareWorkflow
} from "../../packages/profile-generic-software/dist/index.js";
import {
  DETERMINISTIC_EVALUATOR_CONFIGURATION_SCHEMA_DIGEST,
  DeterministicEvidenceEvaluator,
  deterministicEvaluatorConfigurationDigest
} from "../../packages/evaluator-deterministic/dist/index.js";
import {
  GenericCommandAgentDriver,
  buildGenericCommandDockerArgs
} from "../../packages/driver-generic-command/dist/index.js";
import { GitHubAppAdapter, githubPayloadDigest } from "../../packages/adapter-github/dist/index.js";
import {
  DesktopNotificationAdapter,
  SignedWebhookAdapter,
  notificationPayloadDigest
} from "../../packages/adapter-notifications/dist/index.js";
import { CodexSdkDriver } from "../../packages/driver-codex/dist/index.js";
import { ClaudeSdkDriver } from "../../packages/driver-claude/dist/index.js";
import { buildProviderRunnerDockerArgs } from "../../packages/runtime/dist/index.js";
import { createTarGz, directoryEntries } from "../release/archive.mjs";

const releaseDirectory = resolve(process.argv[2] ?? ".parallelplay-release/final");
const sourceCommit = process.argv[3] ?? "";
if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) {
  throw new Error("run-first-party.mjs requires an exact source commit");
}
const attestationBundlePath = resolve(process.argv[4] ?? "");
if (!process.argv[4] || !existsSync(attestationBundlePath)) {
  throw new Error("run-first-party.mjs requires the primary artifact attestation bundle");
}
const output = join(releaseDirectory, "conformance");
mkdirSync(output, { recursive: true, mode: 0o755 });
const buildManifest = JSON.parse(
  readFileSync(join(releaseDirectory, "build-manifest.json"), "utf8")
);
const sourceDateEpoch = Number(buildManifest.sourceDateEpoch);
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
  throw new Error("Release build manifest has no valid source epoch");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const attestationDigest = fileDigest(attestationBundlePath);
const releaseManifests = new Map();

function predictedConformanceReportDigest(contract, manifest) {
  const requirements = CONFORMANCE_REQUIREMENTS_V1[contract];
  if (!requirements) throw new Error(`Unknown conformance contract: ${contract}`);
  return digest({
    schemaVersion: 1,
    suiteVersion: "0.1.0",
    contract,
    extensionId: manifest.id,
    extensionVersion: manifest.extensionVersion,
    sourceCommit,
    artifactDigest: manifest.artifact.sha256,
    platform: { os: process.platform, arch: process.arch, node: process.version },
    checks: requirements.map((id) => ({ id, status: "passed", detail: "Passed" })),
    passed: true
  });
}

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function rejects(operation, pattern) {
  try {
    await operation();
  } catch (error) {
    if (!pattern || pattern.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
  throw new Error("Expected operation to reject");
}

function artifact(prefix) {
  const entries = buildManifest.artifacts.filter((entry) => entry.name.startsWith(prefix));
  if (entries.length !== 1) throw new Error(`Expected one release artifact for ${prefix}`);
  return entries[0];
}

function harnessManifest({
  id,
  displayName,
  kind,
  contract,
  artifact: subject,
  configurationSchemaDigest
}) {
  const manifest = {
    schemaVersion: 1,
    id,
    displayName,
    extensionVersion: buildManifest.version,
    kind,
    contract: { name: contract, version: 1 },
    artifact: {
      mediaType: subject.name.endsWith(".oci.tar")
        ? "application/vnd.oci.image.manifest.v1+json"
        : "application/vnd.parallelplay.builtin+json",
      reference: `https://github.com/anirudh/parallelplay/releases/download/${buildManifest.releaseTag}/${subject.name}`,
      sha256: subject.sha256
    },
    configurationSchemaDigest,
    capabilities: [],
    provenance: {
      sourceRepository: "https://github.com/anirudh/parallelplay",
      sourceRevision: sourceCommit,
      sbomDigest: fileDigest(join(releaseDirectory, `${subject.name}.spdx.json`)),
      attestationDigest
    },
    conformance: {
      suiteVersion: "0.1.0",
      reportDigest: "0".repeat(64),
      approvedRegistryDigest: null
    }
  };
  manifest.conformance.reportDigest = predictedConformanceReportDigest(contract, manifest);
  releaseManifests.set(id, manifest);
  return manifest;
}

const workflowArtifact = artifact("parallelplay-profile-generic-software-");
const workflowManifest = harnessManifest({
  id: "generic-software",
  displayName: "Generic software workflow",
  kind: "workflow",
  contract: "workflow-extension-v1",
  artifact: workflowArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "workflow-profile" })
});
const baseWorkflowRequest = {
  schemaVersion: 1,
  profileId: "generic-software",
  intentDigest: digest("intent"),
  milestones: [
    { id: "specify", title: "Specify", dependencies: [], criteria: ["Specified"] },
    { id: "implement", title: "Implement", dependencies: ["specify"], criteria: ["Implemented"] },
    { id: "verify", title: "Verify", dependencies: ["implement"], criteria: ["Verified"] }
  ]
};

function workflowCases() {
  return [
    {
      id: "schema-validation",
      run: async (subject) =>
        rejects(() => subject.compile({ ...baseWorkflowRequest, extra: true }))
    },
    {
      id: "dag-compilation",
      run: async (subject) => {
        const result = await subject.compile(baseWorkflowRequest);
        invariant(result.accepted && result.workflowDigest, "Valid DAG was not compiled");
        invariant(
          JSON.stringify(result.normalized.milestoneOrder) ===
            JSON.stringify(["specify", "implement", "verify"]),
          "DAG order is not deterministic"
        );
      }
    },
    {
      id: "cycle-rejection",
      run: async (subject) => {
        const result = await subject.compile({
          ...baseWorkflowRequest,
          milestones: [
            { id: "left", title: "Left", dependencies: ["right"], criteria: ["Left"] },
            { id: "right", title: "Right", dependencies: ["left"], criteria: ["Right"] }
          ]
        });
        invariant(
          !result.accepted && result.errors.some((entry) => entry.code === "cycle"),
          "Cycle was accepted"
        );
      }
    },
    {
      id: "dependency-validation",
      run: async (subject) => {
        const result = await subject.compile({
          ...baseWorkflowRequest,
          milestones: [{ id: "one", title: "One", dependencies: ["missing"], criteria: ["One"] }]
        });
        invariant(
          !result.accepted && result.errors.some((entry) => entry.code === "unknown-dependency"),
          "Unknown dependency was accepted"
        );
      }
    },
    {
      id: "stale-revisions",
      run: async (subject) => {
        const first = await subject.compile(baseWorkflowRequest);
        const stale = await subject.compile({
          ...baseWorkflowRequest,
          intentDigest: digest("new-intent")
        });
        invariant(
          first.workflowDigest !== stale.workflowDigest,
          "Stale intent retained the same workflow digest"
        );
      }
    },
    {
      id: "serial-lineage",
      run: async (subject) => {
        const result = await subject.compile(baseWorkflowRequest);
        const byId = new Map(result.normalized.milestones.map((entry) => [entry.id, entry]));
        invariant(
          canonical(byId.get("implement")?.dependencies) === canonical(["specify"]) &&
            canonical(byId.get("verify")?.dependencies) === canonical(["implement"]),
          "Serial lineage was not retained"
        );
      }
    },
    {
      id: "controlled-concurrency",
      run: async (subject) => {
        const result = await subject.compile({
          ...baseWorkflowRequest,
          milestones: [
            { id: "left", title: "Left", dependencies: [], criteria: ["Left"] },
            { id: "right", title: "Right", dependencies: [], criteria: ["Right"] },
            { id: "join", title: "Join", dependencies: ["left", "right"], criteria: ["Joined"] }
          ]
        });
        invariant(
          JSON.stringify(result.normalized.milestoneOrder) ===
            JSON.stringify(["left", "right", "join"]),
          "Independent nodes or join order were not deterministic"
        );
      }
    },
    {
      id: "leases",
      run: async (subject) => {
        const result = await subject.compile(baseWorkflowRequest);
        invariant(
          !canonical(result).includes("leaseToken"),
          "Workflow extension minted host lease authority"
        );
      }
    },
    {
      id: "integration-ordering",
      run: async (subject) => {
        const result = await subject.compile({
          ...baseWorkflowRequest,
          milestones: [
            ...baseWorkflowRequest.milestones,
            {
              id: "integrate",
              title: "Integrate",
              dependencies: ["verify"],
              criteria: ["Integrated"]
            }
          ]
        });
        invariant(
          result.normalized.milestoneOrder.at(-1) === "integrate",
          "Integration was not ordered last"
        );
      }
    },
    {
      id: "reverification-after-rebase",
      run: async (subject) => {
        const before = await subject.compile(baseWorkflowRequest);
        const after = await subject.compile({
          ...baseWorkflowRequest,
          milestones: baseWorkflowRequest.milestones.map((entry) =>
            entry.id === "verify" ? { ...entry, criteria: ["Verified after rebase"] } : entry
          )
        });
        invariant(
          before.workflowDigest !== after.workflowDigest,
          "Rebase criteria did not invalidate verification"
        );
      }
    }
  ];
}

const evaluatorArtifact = artifact("parallelplay-evaluator-deterministic-");
const evaluatorManifest = harnessManifest({
  id: "deterministic-evaluator",
  displayName: "Deterministic evaluator",
  kind: "evaluator",
  contract: "evaluator-extension-v1",
  artifact: evaluatorArtifact,
  configurationSchemaDigest: DETERMINISTIC_EVALUATOR_CONFIGURATION_SCHEMA_DIGEST
});
const corpusDigest = digest("holdout-corpus");
const evaluatorConfiguration = {
  schemaVersion: 1,
  minimumMeanScore: 0.5,
  minimumSamples: 20,
  allowedCorpusDigest: corpusDigest
};
function evidence(overrides = {}) {
  return {
    schemaVersion: 1,
    partition: "holdout",
    blinded: true,
    contaminated: false,
    scores: Array.from({ length: 20 }, () => 1),
    abstentionReason: null,
    baselineDigest: corpusDigest,
    currentCorpusDigest: corpusDigest,
    ...overrides
  };
}
function evaluationRequest(value) {
  return {
    schemaVersion: 1,
    subjectDigest: digest("subject"),
    evidenceDigest: digest(value),
    evidence: value,
    evaluatorConfigurationDigest: deterministicEvaluatorConfigurationDigest(evaluatorConfiguration)
  };
}
function evaluatorCases() {
  return [
    {
      id: "blinding",
      run: (subject) =>
        rejects(() => subject.evaluate(evaluationRequest(evidence({ blinded: false }))))
    },
    {
      id: "partition-separation",
      run: (subject) =>
        rejects(() => subject.evaluate(evaluationRequest(evidence({ partition: "training" }))))
    },
    {
      id: "contamination",
      run: async (subject) =>
        invariant(
          !(await subject.evaluate(evaluationRequest(evidence({ contaminated: true })))).passed,
          "Contamination passed"
        )
    },
    {
      id: "abstention",
      run: async (subject) =>
        invariant(
          !(
            await subject.evaluate(
              evaluationRequest(evidence({ abstentionReason: "insufficient evidence" }))
            )
          ).passed,
          "Abstention passed"
        )
    },
    {
      id: "confidence-bounds",
      run: async (subject) =>
        invariant(
          !(await subject.evaluate(evaluationRequest(evidence({ scores: [1] })))).passed,
          "Underpowered evidence passed"
        )
    },
    {
      id: "drift",
      run: async (subject) =>
        invariant(
          !(
            await subject.evaluate(
              evaluationRequest(evidence({ currentCorpusDigest: digest("drift") }))
            )
          ).passed,
          "Drifted corpus passed"
        )
    },
    {
      id: "invalid-output",
      run: (subject) =>
        rejects(() =>
          subject.evaluate({ ...evaluationRequest(evidence()), evidenceDigest: digest("wrong") })
        )
    },
    {
      id: "deterministic-scoring",
      run: async (subject) => {
        const request = evaluationRequest(evidence());
        invariant(
          canonical(await subject.evaluate(request)) === canonical(await subject.evaluate(request)),
          "Scoring is nondeterministic"
        );
      }
    }
  ];
}

const policyArtifact = workflowArtifact;
const policyManifest = harnessManifest({
  id: "generic-safety-ceiling",
  displayName: "Generic safety ceiling",
  kind: "policy",
  contract: "policy-extension-v1",
  artifact: policyArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "immutable-global-ceiling" })
});
function policyRequest(action, overrides = {}) {
  return {
    schemaVersion: 1,
    policyDigest: digest("policy"),
    evidenceDigest: digest("evidence"),
    proposedAction: action,
    risk: "low",
    irreversible: false,
    externalEffect: action.startsWith("github.") || action.startsWith("notification."),
    ...overrides
  };
}
function policyCases() {
  const allowed = [
    "attention.reprioritize",
    "record.approve",
    "github.check.upsert",
    "github.label.upsert",
    "github.comment.create",
    "github.candidate-branch.create",
    "github.draft-pr.create",
    "github.draft-pr.update",
    "notification.desktop.deliver",
    "notification.webhook.deliver"
  ];
  const forbidden = [
    "merge",
    "ready-for-review",
    "release",
    "deploy",
    "scope.accept",
    "graph.accept",
    "outcome.accept",
    "policy.promote",
    "permission.change",
    "secret.change",
    "capability.expand"
  ];
  return [
    {
      id: "classification-integrity",
      run: async (subject) => {
        invariant(
          (await subject.decide(policyRequest("github.comment.create"))).decision ===
            "allow_within_global_ceiling",
          "Low-risk action denied"
        );
        invariant(
          (await subject.decide(policyRequest("github.comment.create", { risk: "high" })))
            .decision === "deny",
          "High-risk action allowed"
        );
      }
    },
    {
      id: "promotion-binding",
      run: async (subject) => {
        const request = policyRequest("github.check.upsert");
        const result = await subject.decide(request);
        invariant(
          result.policyDigest === request.policyDigest &&
            result.evidenceDigest === request.evidenceDigest &&
            result.proposedAction === request.proposedAction,
          "Policy output lost promotion bindings"
        );
      }
    },
    {
      id: "expiry",
      run: async (subject) =>
        invariant(
          !("expiresAt" in (await subject.decide(policyRequest("record.approve")))),
          "Policy extension minted expiry authority"
        )
    },
    {
      id: "audit-suspension",
      run: async (subject) =>
        invariant(
          !canonical(await subject.decide(policyRequest("record.approve"))).includes("suspend"),
          "Policy extension bypassed host suspension"
        )
    },
    {
      id: "low-risk-allowlist",
      run: async (subject) => {
        for (const action of allowed)
          invariant(
            (await subject.decide(policyRequest(action))).decision ===
              "allow_within_global_ceiling",
            `${action} was not allowlisted`
          );
      }
    },
    {
      id: "global-authority-ceiling",
      run: async (subject) => {
        for (const action of forbidden)
          invariant(
            (await subject.decide(policyRequest(action))).decision === "deny",
            `${action} escaped the global ceiling`
          );
      }
    }
  ];
}

const genericArtifact = artifact("parallelplay-driver-generic-command-");
const genericManifest = harnessManifest({
  id: "generic-command",
  displayName: "Generic command driver",
  kind: "driver",
  contract: "agent-driver-v1",
  artifact: genericArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "generic-command-driver" })
});
const genericImage =
  "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854";

function driverLaunch(wallTimeMs = 10_000) {
  const capabilityManifest = {
    schemaVersion: 3,
    workspace: "read_write",
    artifactOutput: "read_write",
    scratch: "read_write",
    context: { access: "read_only", digest: digest("generic-context-packet") },
    resources: {
      cpuLimit: 1,
      memoryLimitBytes: 268_435_456,
      pidsLimit: 64,
      wallTimeMs
    },
    network: [],
    secretHandles: [],
    git: []
  };
  return {
    schemaVersion: 1,
    effectKey: `conformance:${randomUUID()}`,
    runId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    contextDigest: digest("generic-context"),
    executionContractDigest: digest("generic-execution"),
    capabilityManifest,
    capabilityManifestDigest: digest(capabilityManifest),
    prompt: "Run the public deterministic conformance fixture.",
    requestedModel: null
  };
}

const successProgram =
  "const fs=require('node:fs');fs.writeFileSync('/artifacts/result.txt','fixture artifact\\n');for(const e of [{schemaVersion:1,sequence:1,type:'started'},{schemaVersion:1,sequence:2,type:'capability.used',capability:'artifact.write'},{schemaVersion:1,sequence:3,type:'artifact.declared',path:'result.txt',role:'agent.output'},{schemaVersion:1,sequence:4,type:'usage'},{schemaVersion:1,sequence:5,type:'terminal',outcome:'succeeded'}])console.log(JSON.stringify(e));";

function genericProgram(requirement) {
  if (requirement === "approvals") {
    return "console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));console.log(JSON.stringify({schemaVersion:1,sequence:2,type:'approval.requested',requestId:'10000000-0000-4000-8000-000000000001',capability:'network',reason:'fixture request'}));";
  }
  if (
    requirement === "timeout" ||
    requirement === "resume" ||
    requirement === "crash-recovery" ||
    requirement === "cancellation"
  ) {
    return "console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));setTimeout(()=>{},30000);";
  }
  if (requirement === "malformed-events") return "console.log('{not-json');";
  if (requirement === "missing-terminal-state") {
    return "console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));";
  }
  if (requirement === "secret-denial") {
    return "const leaked=Object.keys(process.env).some(k=>/(OPENAI|ANTHROPIC|GITHUB).*(KEY|TOKEN|SECRET)/.test(k));console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));console.log(JSON.stringify({schemaVersion:1,sequence:2,type:'terminal',outcome:leaked?'failed':'succeeded'}));";
  }
  if (requirement === "network-denial") {
    return "console.log(JSON.stringify({schemaVersion:1,sequence:1,type:'started'}));fetch('https://example.com',{signal:AbortSignal.timeout(500)}).then(()=>console.log(JSON.stringify({schemaVersion:1,sequence:2,type:'terminal',outcome:'failed'})),()=>console.log(JSON.stringify({schemaVersion:1,sequence:2,type:'terminal',outcome:'succeeded'})));";
  }
  return successProgram;
}

function createGenericDriver(requirement) {
  const root = mkdtempSync(join(tmpdir(), `parallelplay-conformance-${requirement}-`));
  const options = {
    manifest: genericManifest,
    image: genericImage,
    command: ["node", "-e", genericProgram(requirement)],
    workspaceRoot: join(root, "workspaces"),
    sessionRoot: join(root, "sessions")
  };
  const driver = new GenericCommandAgentDriver(options);
  driver.restartForConformance = () => new GenericCommandAgentDriver(options);
  return driver;
}

async function terminalBatch(driver, sessionId) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const batch = await driver.inspect({ schemaVersion: 1, sessionId, afterSequence: 0 });
    if (batch.status !== "running") return batch;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("Driver conformance case did not reach a terminal state");
}

function genericDriverCases() {
  return [
    {
      id: "lifecycle",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "succeeded",
          "Lifecycle did not succeed"
        );
        invariant(
          (await subject.collectReceipt(session.sessionId)).outcome === "succeeded",
          "Terminal receipt was unavailable"
        );
      }
    },
    {
      id: "resume",
      run: async (subject) => {
        const request = driverLaunch();
        const session = await subject.start(request);
        await subject.resume({
          schemaVersion: 1,
          effectKey: `resume:${request.effectKey}`,
          sessionId: session.sessionId,
          checkpointDigest: session.checkpointDigest,
          contextDigest: request.contextDigest,
          executionContractDigest: request.executionContractDigest,
          capabilityManifestDigest: request.capabilityManifestDigest
        });
        await subject.cancel({
          schemaVersion: 1,
          effectKey: `cancel:${request.effectKey}`,
          sessionId: session.sessionId,
          reason: "operator_cancelled"
        });
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "operator_cancelled",
          "Resumed session did not remain cancellable"
        );
      }
    },
    {
      id: "event-ordering",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.events.every((entry, index) => entry.sequence === index + 1),
          "Event sequence was not contiguous"
        );
      }
    },
    {
      id: "usage",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.events.some((entry) => entry.type === "usage"),
          "Usage event was absent"
        );
      }
    },
    {
      id: "cost-availability",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        const usage = batch.events.find((entry) => entry.type === "usage");
        invariant(
          usage?.type === "usage" &&
            usage.monetaryCost.status === "unavailable" &&
            usage.monetaryCost.reason.length > 0,
          "Unavailable cost was not explicit"
        );
      }
    },
    {
      id: "artifacts",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        const artifactEvent = batch.events.find((entry) => entry.type === "artifact.declared");
        invariant(
          artifactEvent?.type === "artifact.declared" &&
            artifactEvent.size > 0 &&
            /^[a-f0-9]{64}$/.test(artifactEvent.sha256),
          "Artifact evidence was not digest-bound"
        );
      }
    },
    {
      id: "approvals",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.status === "approval_required" &&
            batch.events.some((entry) => entry.type === "approval.requested"),
          "Approval request did not fail closed"
        );
      }
    },
    {
      id: "cancellation",
      run: async (subject) => {
        const request = driverLaunch();
        const session = await subject.start(request);
        await subject.cancel({
          schemaVersion: 1,
          effectKey: `cancel:${request.effectKey}`,
          sessionId: session.sessionId,
          reason: "operator_cancelled"
        });
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "operator_cancelled",
          "Cancellation was not terminal"
        );
      }
    },
    {
      id: "timeout",
      run: async (subject) => {
        const session = await subject.start(driverLaunch(25));
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "timed_out",
          "Wall-time expiry was not terminal"
        );
      }
    },
    {
      id: "malformed-events",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "protocol_invalid",
          "Malformed event was accepted"
        );
      }
    },
    {
      id: "missing-terminal-state",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "protocol_invalid",
          "Missing terminal state was accepted"
        );
      }
    },
    {
      id: "duplicate-delivery",
      run: async (subject) => {
        const request = driverLaunch();
        const first = await subject.start(request);
        const duplicate = await subject.start(request);
        invariant(
          first.sessionId === duplicate.sessionId,
          "Duplicate launch created a second effect"
        );
        invariant(
          (await terminalBatch(subject, first.sessionId)).status === "succeeded",
          "Deduplicated effect did not converge"
        );
      }
    },
    {
      id: "crash-recovery",
      run: async (subject) => {
        const request = driverLaunch();
        const session = await subject.start(request);
        const restarted = subject.restartForConformance();
        try {
          const resumed = await restarted.resume({
            schemaVersion: 1,
            effectKey: `restart:${request.effectKey}`,
            sessionId: session.sessionId,
            checkpointDigest: session.checkpointDigest,
            contextDigest: request.contextDigest,
            executionContractDigest: request.executionContractDigest,
            capabilityManifestDigest: request.capabilityManifestDigest
          });
          invariant(
            resumed.sessionId === session.sessionId,
            "Restart did not reattach the exact session"
          );
          await restarted.cancel({
            schemaVersion: 1,
            effectKey: `cancel:${request.effectKey}`,
            sessionId: session.sessionId,
            reason: "operator_cancelled"
          });
        } finally {
          await restarted.close();
        }
      }
    },
    {
      id: "containment",
      run: async () => {
        const request = driverLaunch();
        const args = buildGenericCommandDockerArgs({
          name: "pp-generic-conformance",
          image: genericImage,
          command: ["node", "fixture.js"],
          workspace: "/private/workspace",
          artifacts: "/private/artifacts",
          scratch: "/private/scratch",
          context: "/private/context",
          capabilityManifest: request.capabilityManifest
        });
        invariant(
          args.includes("none") &&
            args.includes("--read-only") &&
            args.includes("no-new-privileges"),
          "Hardened Docker boundary was incomplete"
        );
        invariant(
          !/docker\.sock|host\.docker\.internal/.test(args.join(" ")),
          "Host capability leaked into Docker arguments"
        );
      }
    },
    {
      id: "secret-denial",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "succeeded",
          "Host secret reached the generic container"
        );
      }
    },
    {
      id: "network-denial",
      run: async (subject) => {
        const session = await subject.start(driverLaunch());
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.status === "succeeded",
          `Generic container network-denial probe ended ${batch.status}: ${canonical(batch.events)}`
        );
      }
    }
  ];
}

const githubArtifact = artifact("parallelplay-adapter-github-");
const notificationArtifact = artifact("parallelplay-adapter-notifications-");
const githubManifest = harnessManifest({
  id: "github-app",
  displayName: "GitHub App",
  kind: "adapter",
  contract: "outbound-adapter-v1",
  artifact: githubArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "github-app" })
});
const desktopManifest = harnessManifest({
  id: "desktop-notification",
  displayName: "Desktop notification",
  kind: "adapter",
  contract: "outbound-adapter-v1",
  artifact: notificationArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "desktop-notification" })
});
const webhookManifest = harnessManifest({
  id: "signed-webhook",
  displayName: "Signed webhook",
  kind: "adapter",
  contract: "outbound-adapter-v1",
  artifact: notificationArtifact,
  configurationSchemaDigest: digest({ schemaVersion: 1, type: "signed-webhook" })
});

function conformanceAuthority() {
  return {
    stale: false,
    receipts: [],
    failures: [],
    async authorize() {
      if (this.stale) throw new Error("Outbound precondition is stale");
      return { status: "authorized", authorizationDigest: "a".repeat(64) };
    },
    async recordReceipt(_request, receipt) {
      this.receipts.push(receipt);
    },
    async recordFailure(_request, failure) {
      this.failures.push(failure);
    }
  };
}

function verifyReceipt(request, receipt) {
  const { receiptDigest, ...unsigned } = receipt;
  invariant(receipt.adapterId === request.adapterId, "Receipt adapter binding was lost");
  invariant(receipt.effectKey === request.effectKey, "Receipt effect binding was lost");
  invariant(receipt.action === request.action, "Receipt action binding was lost");
  invariant(receipt.payloadDigest === request.payloadDigest, "Receipt payload binding was lost");
  invariant(digest(unsigned) === receiptDigest, "Receipt digest was invalid");
}

function adapterCases() {
  return CONFORMANCE_REQUIREMENTS_V1["outbound-adapter-v1"].map((id) => ({
    id,
    run: (subject) => subject.runConformanceCase(id)
  }));
}

function createGitHubConformanceSubject() {
  const authority = conformanceAuthority();
  const token = ["installation", "token", "conformance", "private"].join("-");
  let stored = null;
  let writes = 0;
  let timeoutAfterCreate = false;
  const observations = [];
  const fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    observations.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? "")
    });
    if (init?.method === "GET" && url.includes("/issues/7/comments?")) {
      return new Response(JSON.stringify(stored ? [stored] : []), {
        status: 200,
        headers: { "content-type": "application/json", "x-github-request-id": "read-1" }
      });
    }
    if (init?.method === "POST" && url.endsWith("/comments")) {
      writes += 1;
      const body = JSON.parse(String(init.body)).body;
      stored ??= { id: 42, url: "https://api.github.test/comments/42", body };
      if (timeoutAfterCreate) {
        timeoutAfterCreate = false;
        throw new Error("simulated timeout after GitHub accepted the effect");
      }
      return new Response(JSON.stringify(stored), {
        status: 201,
        headers: { "content-type": "application/json", "x-github-request-id": "write-1" }
      });
    }
    return new Response("{}", { status: 404 });
  };
  const adapter = new GitHubAppAdapter({
    manifest: githubManifest,
    authority,
    tokenProvider: { getToken: async () => token },
    apiBaseUrl: "https://api.github.test",
    fetch
  });
  const payload = {
    action: "github.comment.create",
    issueNumber: 7,
    body: "The candidate passed the public conformance fixture.",
    allowedLinkHosts: []
  };
  const request = {
    schemaVersion: 1,
    adapterId: "github-app",
    effectKey: `github:${randomUUID()}`,
    action: payload.action,
    target: "anirudh/parallelplay-fixture",
    payload,
    payloadDigest: githubPayloadDigest(payload),
    preconditionDigest: digest("github-precondition"),
    policyPromotionDigest: digest("github-promotion")
  };
  return Object.assign(adapter, {
    async runConformanceCase(id) {
      if (id === "exact-effects") {
        const receipt = await adapter.deliver(request);
        invariant(
          writes === 1 && stored?.body.includes(`parallelplay-effect:${request.effectKey}`),
          "Exact GitHub effect was not created once"
        );
        verifyReceipt(request, receipt);
      } else if (id === "retry-reconciliation") {
        timeoutAfterCreate = true;
        await rejects(() => adapter.deliver(request), /simulated timeout/);
        const recovered = await adapter.deliver(request);
        invariant(
          writes === 1 && recovered.externalId === stored?.url,
          "GitHub timeout retry did not observe and converge"
        );
      } else if (id === "stale-preconditions") {
        authority.stale = true;
        await rejects(() => adapter.deliver(request), /stale/);
        invariant(writes === 0, "Stale GitHub precondition caused a write");
      } else if (id === "duplicate-delivery") {
        const first = await adapter.deliver(request);
        const second = await adapter.deliver(request);
        invariant(
          writes === 1 && first.receiptDigest === second.receiptDigest,
          "Duplicate GitHub effect did not converge"
        );
      } else if (id === "forbidden-operations") {
        await rejects(
          () =>
            adapter.deliver({ ...request, effectKey: "forbidden", action: "merge", payload: {} }),
          /authority ceiling/
        );
        invariant(writes === 0, "Forbidden GitHub operation reached the API");
      } else if (id === "receipt-integrity") {
        verifyReceipt(request, await adapter.deliver(request));
        const reconciliation = await adapter.reconcile({
          schemaVersion: 1,
          effect: request,
          priorReceipt: authority.receipts[0]
        });
        invariant(
          reconciliation.status === "observed_exact" &&
            reconciliation.observedStateDigest === authority.receipts[0].observedStateDigest,
          "GitHub receipt did not reconcile to identical live state"
        );
      } else if (id === "content-filtering") {
        const rejectedPayload = {
          ...payload,
          body: ["@release-bot /deploy", "sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-")
        };
        await rejects(
          () =>
            adapter.deliver({
              ...request,
              effectKey: "filtered",
              payload: rejectedPayload,
              payloadDigest: githubPayloadDigest(rejectedPayload)
            }),
          /secret|mention|slash command/
        );
        invariant(writes === 0, "Filtered GitHub content caused a write");
      } else if (id === "secret-handling") {
        const receipt = await adapter.deliver(request);
        invariant(
          !canonical({
            request,
            receipt,
            observations: observations.map(({ url, body }) => ({ url, body }))
          }).includes(token),
          "GitHub token escaped its authorization header"
        );
        invariant(
          observations.every((entry) => entry.headers.get("authorization") === `Bearer ${token}`),
          "GitHub request omitted its memory-only installation token"
        );
      }
    }
  });
}

const notificationPayload = {
  schemaVersion: 1,
  title: "Review required",
  body: "A bounded decision is waiting.",
  deepLink:
    "http://127.0.0.1:4318/decisions/10000000-0000-4000-8000-000000000001?revision=10000000-0000-4000-8000-000000000002",
  packetId: "10000000-0000-4000-8000-000000000001",
  packetRevisionId: "10000000-0000-4000-8000-000000000002",
  packetRevisionDigest: "b".repeat(64)
};

function notificationRequest(adapterId, action) {
  return {
    schemaVersion: 1,
    adapterId,
    effectKey: `${adapterId}:${randomUUID()}`,
    action,
    target: adapterId === "signed-webhook" ? "hooks.example.test" : "local-desktop",
    payload: notificationPayload,
    payloadDigest: notificationPayloadDigest(notificationPayload),
    preconditionDigest: digest(`${adapterId}-precondition`),
    policyPromotionDigest: digest(`${adapterId}-promotion`)
  };
}

function createDesktopConformanceSubject() {
  const authority = conformanceAuthority();
  const delivered = new Set();
  const deliveries = [];
  let timeoutAfterDelivery = false;
  const bridge = {
    async deliver(notification) {
      deliveries.push(notification);
      delivered.add(notification.identifier);
      if (timeoutAfterDelivery) {
        timeoutAfterDelivery = false;
        throw new Error("simulated bridge timeout after delivery");
      }
      return { systemId: notification.identifier };
    },
    async query(identifier) {
      return { status: delivered.has(identifier) ? "delivered" : "not_delivered" };
    },
    async close() {}
  };
  const adapter = new DesktopNotificationAdapter({ manifest: desktopManifest, authority, bridge });
  const request = notificationRequest("desktop-notification", "notification.desktop.deliver");
  return Object.assign(adapter, {
    async runConformanceCase(id) {
      if (id === "exact-effects") {
        const receipt = await adapter.deliver(request);
        invariant(
          deliveries.length === 1 && deliveries[0].deepLink === notificationPayload.deepLink,
          "Desktop effect was not exact"
        );
        verifyReceipt(request, receipt);
      } else if (id === "retry-reconciliation") {
        timeoutAfterDelivery = true;
        await rejects(() => adapter.deliver(request), /timeout/);
        const recovered = await adapter.deliver(request);
        invariant(
          deliveries.length === 1 && recovered.externalId.startsWith("desktop:"),
          "Desktop retry did not reconcile before replacement"
        );
      } else if (id === "stale-preconditions") {
        authority.stale = true;
        await rejects(() => adapter.deliver(request), /stale/);
        invariant(deliveries.length === 0, "Stale desktop effect was delivered");
      } else if (id === "duplicate-delivery") {
        const first = await adapter.deliver(request);
        const second = await adapter.deliver(request);
        invariant(
          deliveries.length === 1 && first.receiptDigest === second.receiptDigest,
          "Desktop duplicate did not converge"
        );
      } else if (id === "forbidden-operations") {
        await rejects(
          () => adapter.deliver({ ...request, effectKey: "forbidden", action: "release" }),
          /accepts only/
        );
        invariant(deliveries.length === 0, "Forbidden desktop operation was delivered");
      } else if (id === "receipt-integrity") {
        verifyReceipt(request, await adapter.deliver(request));
      } else if (id === "content-filtering") {
        const payload = {
          ...notificationPayload,
          body: ["sk", "ant", "abcdefghijklmnopqrstuvwxyz"].join("-")
        };
        await rejects(
          () =>
            adapter.deliver({
              ...request,
              effectKey: "filtered",
              payload,
              payloadDigest: notificationPayloadDigest(payload)
            }),
          /secret-like/
        );
        invariant(deliveries.length === 0, "Secret-bearing desktop content was delivered");
      } else if (id === "secret-handling") {
        const receipt = await adapter.deliver(request);
        invariant(
          !canonical({ request, receipt, deliveries }).includes("csrf") &&
            !canonical({ request, receipt, deliveries }).includes("session-secret"),
          "Desktop payload included authority material"
        );
      }
    }
  });
}

function createWebhookConformanceSubject() {
  const authority = conformanceAuthority();
  const signingSecret = "conformance-webhook-secret-at-least-32-bytes";
  const ledger = new Map();
  const observations = [];
  let creations = 0;
  let postAttempts = 0;
  let timeoutAfterCreate = false;
  const fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    observations.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: String(init?.body ?? "")
    });
    if (init?.method === "POST") {
      postAttempts += 1;
      const body = JSON.parse(String(init.body));
      const receiptUrl = `${url}/receipts/${createHash("sha256").update(body.idempotencyKey).digest("hex")}`;
      if (!ledger.has(receiptUrl)) {
        creations += 1;
        ledger.set(receiptUrl, {
          schemaVersion: 1,
          idempotencyKey: body.idempotencyKey,
          payloadDigest: notificationPayloadDigest(body.notification),
          status: "accepted"
        });
      }
      if (timeoutAfterCreate) {
        timeoutAfterCreate = false;
        throw new Error("simulated webhook timeout after acceptance");
      }
      return new Response(JSON.stringify(ledger.get(receiptUrl)), {
        status: 202,
        headers: { location: receiptUrl, "x-request-id": "webhook-1" }
      });
    }
    if (init?.method === "GET") {
      const receipt = ledger.get(url);
      return receipt
        ? new Response(JSON.stringify(receipt), { status: 200 })
        : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 405 });
  };
  const adapter = new SignedWebhookAdapter({
    manifest: webhookManifest,
    authority,
    endpoint: "https://hooks.example.test/parallelplay",
    signingSecret,
    fetch
  });
  const request = notificationRequest("signed-webhook", "notification.webhook.deliver");
  return Object.assign(adapter, {
    async runConformanceCase(id) {
      if (id === "exact-effects") {
        const receipt = await adapter.deliver(request);
        invariant(
          creations === 1 && postAttempts === 1,
          "Webhook exact effect was not accepted once"
        );
        verifyReceipt(request, receipt);
      } else if (id === "retry-reconciliation") {
        timeoutAfterCreate = true;
        await rejects(() => adapter.deliver(request), /timeout/);
        const reconciliation = await adapter.reconcile({
          schemaVersion: 1,
          effect: request,
          priorReceipt: null
        });
        invariant(
          reconciliation.status === "observed_exact" && creations === 1,
          "Webhook restart reconciliation did not find the accepted effect"
        );
      } else if (id === "stale-preconditions") {
        authority.stale = true;
        await rejects(() => adapter.deliver(request), /stale/);
        invariant(creations === 0, "Stale webhook precondition caused a POST");
      } else if (id === "duplicate-delivery") {
        const first = await adapter.deliver(request);
        const second = await adapter.deliver(request);
        invariant(
          creations === 1 && postAttempts === 1 && first.receiptDigest === second.receiptDigest,
          "Webhook duplicate did not converge"
        );
      } else if (id === "forbidden-operations") {
        await rejects(
          () => adapter.deliver({ ...request, effectKey: "forbidden", action: "deploy" }),
          /accepts only/
        );
        invariant(creations === 0, "Forbidden webhook operation was delivered");
      } else if (id === "receipt-integrity") {
        verifyReceipt(request, await adapter.deliver(request));
      } else if (id === "content-filtering") {
        const payload = {
          ...notificationPayload,
          body: ["github", "pat", "abcdefghijklmnopqrstuvwxyz"].join("_")
        };
        await rejects(
          () =>
            adapter.deliver({
              ...request,
              effectKey: "filtered",
              payload,
              payloadDigest: notificationPayloadDigest(payload)
            }),
          /secret-like/
        );
        invariant(creations === 0, "Secret-bearing webhook content was sent");
      } else if (id === "secret-handling") {
        const receipt = await adapter.deliver(request);
        invariant(
          !canonical({ request, receipt, observations }).includes(signingSecret),
          "Webhook signing secret escaped into effect evidence"
        );
        invariant(
          observations.every(
            (entry) => !entry.url.includes(signingSecret) && !entry.body.includes(signingSecret)
          ),
          "Webhook signing secret entered URL or body"
        );
      }
    }
  });
}

function providerRunnerIdentity() {
  const targetPlatform =
    process.platform === "darwin"
      ? "linux-arm64"
      : process.arch === "arm64"
        ? "linux-arm64"
        : "linux-x64";
  const path = join(
    releaseDirectory,
    `provider-images-${buildManifest.version}-${targetPlatform}.json`
  );
  const providerManifest = JSON.parse(readFileSync(path, "utf8"));
  const runner = providerManifest.images.find((entry) => entry.name === "provider-runner");
  if (
    !runner ||
    !/^[a-f0-9]{64}$/.test(runner.imageDigest) ||
    !runner.reference.endsWith(`@sha256:${runner.imageDigest}`) ||
    typeof runner.releaseAsset !== "string"
  ) {
    throw new Error("Release provider manifest has no digest-bound runner image");
  }
  return { ...runner, platform: targetPlatform };
}

function providerDriverManifest(provider, identity) {
  const id = provider === "openai" ? "codex-sdk" : "claude-agent-sdk";
  const displayName = provider === "openai" ? "Codex SDK" : "Claude Agent SDK";
  const manifest = {
    schemaVersion: 1,
    id,
    displayName,
    extensionVersion: buildManifest.version,
    kind: "driver",
    contract: { name: "agent-driver-v1", version: 1 },
    artifact: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      reference: identity.reference,
      sha256: identity.imageDigest
    },
    configurationSchemaDigest: digest({ schemaVersion: 1, provider, sdk: id }),
    capabilities: [
      { name: "provider-api", required: true },
      { name: "workspace-read-write", required: true }
    ],
    provenance: {
      sourceRepository: "https://github.com/anirudh/parallelplay",
      sourceRevision: sourceCommit,
      sbomDigest: fileDigest(join(releaseDirectory, `${identity.releaseAsset}.spdx.json`)),
      attestationDigest
    },
    conformance: {
      suiteVersion: "0.1.0",
      reportDigest: "0".repeat(64),
      approvedRegistryDigest: null
    }
  };
  manifest.conformance.reportDigest = predictedConformanceReportDigest("agent-driver-v1", manifest);
  releaseManifests.set(id, manifest);
  return manifest;
}

function providerLaunch(provider, wallTimeMs = 10_000) {
  const model = provider === "openai" ? "gpt-conformance" : "claude-conformance";
  const capabilityManifest = {
    schemaVersion: 3,
    workspace: "read_write",
    artifactOutput: "read_write",
    scratch: "read_write",
    context: { access: "read_only", digest: digest(`${provider}-context-packet`) },
    resources: {
      cpuLimit: 1,
      memoryLimitBytes: 536_870_912,
      pidsLimit: 64,
      wallTimeMs
    },
    network: [
      {
        broker: "provider-broker",
        provider,
        purpose: "provider_api",
        allowedModels: [model]
      }
    ],
    secretHandles: ["broker-grant"],
    git: []
  };
  return {
    schemaVersion: 1,
    effectKey: `${provider}:${randomUUID()}`,
    runId: randomUUID(),
    jobId: randomUUID(),
    attemptId: randomUUID(),
    contextDigest: digest(`${provider}-context`),
    executionContractDigest: digest(`${provider}-execution`),
    capabilityManifest,
    capabilityManifestDigest: digest(capabilityManifest),
    prompt: "Run the deterministic contained provider conformance fixture.",
    requestedModel: model
  };
}

function codexEvents(mode, model, workspace, release) {
  return (async function* () {
    yield { type: "thread.started", thread_id: "codex-conformance-thread" };
    if (["hanging", "resume"].includes(mode)) {
      await new Promise((resolvePromise) => {
        release.value = resolvePromise;
      });
      return;
    }
    if (mode === "malformed") {
      yield { type: "provider.unknown", secret: ["must", "not", "be", "retained"].join("-") };
      return;
    }
    if (mode === "missing-terminal") return;
    yield { type: "turn.started" };
    if (mode === "duplicate") yield { type: "turn.started" };
    if (mode === "approval") {
      yield { type: "turn.failed", error: { message: "provider requested unavailable approval" } };
      return;
    }
    if (mode === "artifact") {
      writeFileSync(join(workspace, "provider-result.txt"), "contained provider artifact\n", {
        mode: 0o600
      });
    }
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        output_tokens: 4,
        reasoning_output_tokens: 1
      }
    };
  })();
}

function claudeMessages(mode, model, workspace, release) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "system",
        subtype: "init",
        session_id: "claude-conformance-session",
        uuid: "claude-init",
        model,
        permissionMode: "dontAsk"
      };
      if (["hanging", "resume"].includes(mode)) {
        await new Promise((resolvePromise) => {
          release.value = resolvePromise;
        });
        return;
      }
      if (mode === "malformed") {
        yield {
          type: "system",
          subtype: "unknown",
          secret: ["must", "not", "be", "retained"].join("-")
        };
        return;
      }
      if (mode === "missing-terminal") return;
      const status = {
        type: "system",
        subtype: "status",
        status: "requesting",
        session_id: "claude-conformance-session",
        uuid: "claude-status"
      };
      yield status;
      if (mode === "duplicate") yield status;
      if (mode === "artifact") {
        writeFileSync(join(workspace, "provider-result.txt"), "contained provider artifact\n", {
          mode: 0o600
        });
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.001,
        modelUsage: {
          [model]: {
            inputTokens: 12,
            outputTokens: 5,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 0,
            costUSD: 0.001
          }
        },
        permission_denials:
          mode === "approval"
            ? [{ tool_name: "WebFetch", tool_use_id: "tool-1", tool_input: {} }]
            : [],
        session_id: "claude-conformance-session",
        uuid: "claude-result"
      };
    },
    async interrupt() {
      release.value?.();
    }
  };
}

function createProviderConformanceSubject(provider, manifest, requirement) {
  const root = mkdtempSync(join(tmpdir(), `parallelplay-${provider}-${requirement}-`));
  const workspace = join(root, "workspace");
  const sessionDirectory = join(root, "sessions");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const captured = [];
  const releases = [];
  const brokerToken = `run-scoped-${provider}-broker-grant-${"x".repeat(32)}`;
  const mode =
    requirement === "timeout" || requirement === "cancellation"
      ? "hanging"
      : requirement === "resume" || requirement === "crash-recovery"
        ? "resume"
        : requirement === "malformed-events"
          ? "malformed"
          : requirement === "missing-terminal-state"
            ? "missing-terminal"
            : requirement === "duplicate-delivery"
              ? "duplicate"
              : requirement === "approvals"
                ? "approval"
                : requirement === "artifacts"
                  ? "artifact"
                  : "success";

  function makeDriver(nextMode = mode) {
    const release = { value: null };
    releases.push(release);
    if (provider === "openai") {
      return new CodexSdkDriver({
        manifest,
        brokerBaseUrl: "http://provider-relay:4319",
        brokerToken,
        workspace,
        sessionDirectory,
        environment: { PARALLELPLAY_OCI_BOUNDARY: "1" },
        clientFactory: () => ({
          startThread(options) {
            captured.push(options);
            return {
              id: null,
              runStreamed: (_prompt, options) => {
                if (options?.signal) {
                  options.signal.addEventListener("abort", () => release.value?.(), { once: true });
                }
                return Promise.resolve({
                  events: codexEvents(nextMode, "gpt-conformance", workspace, release)
                });
              }
            };
          },
          resumeThread(_id, options) {
            captured.push(options);
            return {
              id: "codex-conformance-thread",
              runStreamed: () =>
                Promise.resolve({
                  events: codexEvents("success", "gpt-conformance", workspace, release)
                })
            };
          }
        })
      });
    }
    return new ClaudeSdkDriver({
      manifest,
      brokerBaseUrl: "http://provider-relay:4319",
      brokerToken,
      workspace,
      sessionDirectory,
      environment: { PARALLELPLAY_OCI_BOUNDARY: "1" },
      queryFactory: (request) => {
        captured.push(request.options);
        return claudeMessages(
          nextMode === "resume" && request.options.resume ? "success" : nextMode,
          "claude-conformance",
          workspace,
          release
        );
      }
    });
  }

  const driver = makeDriver();
  return Object.assign(driver, {
    providerKind: provider,
    brokerToken,
    captured,
    releases,
    restartForConformance: () => makeDriver("success")
  });
}

async function waitForCheckpoint(subject, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const batch = await subject.inspect({ schemaVersion: 1, sessionId, afterSequence: 0 });
    const checkpoint = batch.events.find((entry) => entry.type === "checkpoint");
    if (checkpoint?.type === "checkpoint") return checkpoint.checkpointDigest;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("Provider driver did not publish a restart checkpoint");
}

function providerDriverCases(provider) {
  return [
    {
      id: "lifecycle",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "succeeded",
          "Provider lifecycle did not succeed"
        );
        verifyProviderReceipt(
          await subject.collectReceipt(session.sessionId),
          provider,
          subject.brokerToken
        );
      }
    },
    {
      id: "resume",
      run: async (subject) => {
        const request = providerLaunch(provider);
        const session = await subject.start(request);
        const checkpointDigest = await waitForCheckpoint(subject, session.sessionId);
        const restarted = subject.restartForConformance();
        try {
          await restarted.resume({
            schemaVersion: 1,
            effectKey: `resume:${request.effectKey}`,
            sessionId: session.sessionId,
            checkpointDigest,
            contextDigest: request.contextDigest,
            executionContractDigest: request.executionContractDigest,
            capabilityManifestDigest: request.capabilityManifestDigest
          });
          invariant(
            (await terminalBatch(restarted, session.sessionId)).status === "succeeded",
            "Provider resume did not complete"
          );
        } finally {
          await restarted.close();
        }
      }
    },
    {
      id: "event-ordering",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.events.every((entry, index) => entry.sequence === index + 1),
          "Provider events were not contiguous"
        );
      }
    },
    {
      id: "usage",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        invariant(
          (await terminalBatch(subject, session.sessionId)).events.some(
            (entry) => entry.type === "usage"
          ),
          "Provider usage was absent"
        );
      }
    },
    {
      id: "cost-availability",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const usage = (await terminalBatch(subject, session.sessionId)).events.find(
          (entry) => entry.type === "usage"
        );
        invariant(usage?.type === "usage", "Provider usage was absent");
        invariant(
          provider === "openai"
            ? usage.monetaryCost.status === "unavailable"
            : usage.monetaryCost.status === "known",
          "Provider cost availability was not explicit"
        );
      }
    },
    {
      id: "artifacts",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const artifactEvent = (await terminalBatch(subject, session.sessionId)).events.find(
          (entry) => entry.type === "artifact.declared"
        );
        invariant(
          artifactEvent?.type === "artifact.declared" &&
            artifactEvent.path === "provider-result.txt" &&
            artifactEvent.size > 0,
          "Provider artifact was not declared by digest"
        );
      }
    },
    {
      id: "approvals",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.status !== "succeeded",
          "Provider approval requirement granted itself authority"
        );
        if (provider === "anthropic")
          invariant(
            batch.status === "approval_required" &&
              batch.events.some((entry) => entry.type === "approval.requested"),
            "Claude permission denial was not routed to Attention"
          );
      }
    },
    {
      id: "cancellation",
      run: async (subject) => {
        const request = providerLaunch(provider);
        const session = await subject.start(request);
        await waitForCheckpoint(subject, session.sessionId);
        await subject.cancel({
          schemaVersion: 1,
          effectKey: `cancel:${request.effectKey}`,
          sessionId: session.sessionId,
          reason: "operator_cancelled"
        });
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "operator_cancelled",
          "Provider cancellation was not terminal"
        );
      }
    },
    {
      id: "timeout",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider, 25));
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "timed_out",
          "Provider wall-time expiry was not terminal"
        );
      }
    },
    {
      id: "malformed-events",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const receipt = await eventuallyReceipt(subject, session.sessionId);
        invariant(
          receipt.outcome === "protocol_invalid" &&
            receipt.terminalReason === "provider_event_protocol_invalid" &&
            !canonical(receipt).includes("must-not-be-retained"),
          "Malformed provider event was not rejected safely"
        );
      }
    },
    {
      id: "missing-terminal-state",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        invariant(
          (await terminalBatch(subject, session.sessionId)).status === "protocol_invalid",
          "Missing provider terminal state was accepted"
        );
      }
    },
    {
      id: "duplicate-delivery",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const batch = await terminalBatch(subject, session.sessionId);
        invariant(
          batch.status === "succeeded" &&
            batch.events.filter((entry) => entry.type === "checkpoint").length === 1,
          "Duplicate provider stream delivery did not converge"
        );
      }
    },
    {
      id: "crash-recovery",
      run: async (subject) => {
        const request = providerLaunch(provider);
        const session = await subject.start(request);
        const checkpointDigest = await waitForCheckpoint(subject, session.sessionId);
        const restarted = subject.restartForConformance();
        try {
          await rejects(
            () =>
              restarted.resume({
                schemaVersion: 1,
                effectKey: "wrong-restart",
                sessionId: session.sessionId,
                checkpointDigest,
                contextDigest: "0".repeat(64),
                executionContractDigest: request.executionContractDigest,
                capabilityManifestDigest: request.capabilityManifestDigest
              }),
            /binding/
          );
          await restarted.resume({
            schemaVersion: 1,
            effectKey: `restart:${request.effectKey}`,
            sessionId: session.sessionId,
            checkpointDigest,
            contextDigest: request.contextDigest,
            executionContractDigest: request.executionContractDigest,
            capabilityManifestDigest: request.capabilityManifestDigest
          });
          invariant(
            (await terminalBatch(restarted, session.sessionId)).status === "succeeded",
            "Digest-bound provider crash recovery failed"
          );
        } finally {
          await restarted.close();
        }
      }
    },
    {
      id: "containment",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        await terminalBatch(subject, session.sessionId);
        const options = subject.captured[0];
        if (provider === "openai") {
          invariant(
            options.networkAccessEnabled === false &&
              options.approvalPolicy === "never" &&
              options.webSearchMode === "disabled",
            "Codex SDK options escaped containment policy"
          );
        } else {
          invariant(
            options.permissionMode === "dontAsk" &&
              options.settingSources.length === 0 &&
              options.env.ANTHROPIC_BASE_URL === "http://provider-relay:4319",
            "Claude SDK options escaped containment policy"
          );
        }
        const args = buildProviderRunnerDockerArgs({
          name: "pp-runner-conformance",
          network: "pp-internal-conformance",
          image: subject.manifest.artifact.reference,
          workspace: "/private/workspace",
          session: "/private/session"
        });
        invariant(
          args.includes("--read-only") &&
            args.includes("no-new-privileges") &&
            !/docker\.sock|host\.docker\.internal/.test(args.join(" ")),
          "Provider runner Docker boundary was incomplete"
        );
      }
    },
    {
      id: "secret-denial",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        const receipt = await eventuallyReceipt(subject, session.sessionId);
        invariant(
          !canonical(receipt).includes(subject.brokerToken),
          "Run-scoped broker credential entered provider receipt evidence"
        );
      }
    },
    {
      id: "network-denial",
      run: async (subject) => {
        const session = await subject.start(providerLaunch(provider));
        await terminalBatch(subject, session.sessionId);
        const options = subject.captured[0];
        invariant(
          provider === "openai"
            ? options.networkAccessEnabled === false
            : options.env.ANTHROPIC_BASE_URL === "http://provider-relay:4319",
          "Provider driver gained an undeclared network route"
        );
      }
    }
  ];
}

async function eventuallyReceipt(subject, sessionId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await subject.collectReceipt(sessionId);
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
  throw new Error("Provider receipt did not become terminal");
}

function verifyProviderReceipt(receipt, provider, brokerToken) {
  invariant(receipt.outcome === "succeeded", "Provider receipt did not report success");
  invariant(
    receipt.sdkVersion && /^[a-f0-9]{64}$/.test(receipt.rawStreamDigest),
    "Provider SDK or raw stream digest was absent"
  );
  invariant(
    !canonical(receipt).includes(brokerToken),
    "Provider receipt retained a broker credential"
  );
  invariant(
    receipt.observedModels.length > 0 && receipt.requestedModel,
    `${provider} model identity was absent`
  );
}

const reports = [];
const runnerIdentity = providerRunnerIdentity();
for (const provider of ["openai", "anthropic"]) {
  const manifest = providerDriverManifest(provider, runnerIdentity);
  reports.push(
    await runConformanceHarness({
      contract: "agent-driver-v1",
      manifest,
      sourceCommit,
      createExtension: (requirement) =>
        createProviderConformanceSubject(provider, manifest, requirement),
      cases: providerDriverCases(provider)
    })
  );
}
reports.push(
  await runConformanceHarness({
    contract: "agent-driver-v1",
    manifest: genericManifest,
    sourceCommit,
    createExtension: (requirement) => createGenericDriver(requirement),
    cases: genericDriverCases()
  })
);
for (const [manifest, factory] of [
  [githubManifest, createGitHubConformanceSubject],
  [desktopManifest, createDesktopConformanceSubject],
  [webhookManifest, createWebhookConformanceSubject]
]) {
  reports.push(
    await runConformanceHarness({
      contract: "outbound-adapter-v1",
      manifest,
      sourceCommit,
      createExtension: factory,
      cases: adapterCases()
    })
  );
}
reports.push(
  await runConformanceHarness({
    contract: "workflow-extension-v1",
    manifest: workflowManifest,
    sourceCommit,
    createExtension: () => new GenericSoftwareWorkflow(workflowManifest),
    cases: workflowCases()
  })
);
reports.push(
  await runConformanceHarness({
    contract: "evaluator-extension-v1",
    manifest: evaluatorManifest,
    sourceCommit,
    createExtension: () =>
      new DeterministicEvidenceEvaluator(evaluatorManifest, evaluatorConfiguration),
    cases: evaluatorCases()
  })
);
reports.push(
  await runConformanceHarness({
    contract: "policy-extension-v1",
    manifest: policyManifest,
    sourceCommit,
    createExtension: () => new GenericSafetyPolicy(policyManifest),
    cases: policyCases()
  })
);

const outputByExtension = new Map();
for (const report of reports) {
  if (!report.passed) {
    const failures = report.checks
      .filter((check) => check.status === "failed")
      .map((check) => `${check.id}: ${check.detail}`)
      .join("; ");
    throw new Error(`${report.extensionId} conformance failed: ${failures}`);
  }
  const manifest = releaseManifests.get(report.extensionId);
  if (!manifest) throw new Error(`No release manifest was registered for ${report.extensionId}`);
  if (report.reportDigest !== manifest.conformance.reportDigest) {
    throw new Error(`${report.extensionId} conformance report changed after manifest binding`);
  }
  outputByExtension.set(report.extensionId, writeConformanceOutputs(report, output));
}
const inventory = {
  schemaVersion: 1,
  suiteVersion: "0.1.0",
  sourceCommit,
  reports: reports.map((report) => ({
    extensionId: report.extensionId,
    contract: report.contract,
    artifactDigest: report.artifactDigest,
    reportDigest: report.reportDigest,
    checks: report.checks.length
  }))
};
writeFileSync(join(output, "first-party-inventory.json"), `${canonical(inventory)}\n`, {
  mode: 0o644
});

const manifestDirectory = join(releaseDirectory, "manifests");
const compatibilityDirectory = join(releaseDirectory, "compatibility");
mkdirSync(manifestDirectory, { recursive: true, mode: 0o755 });
mkdirSync(compatibilityDirectory, { recursive: true, mode: 0o755 });
const platform =
  process.platform === "darwin" ? `macos-${process.arch}` : `${process.platform}-${process.arch}`;
if (
  process.env.PARALLELPLAY_CONFORMANCE_PLATFORM &&
  process.env.PARALLELPLAY_CONFORMANCE_PLATFORM !== platform
) {
  throw new Error(
    `Conformance runner platform ${platform} does not match ${process.env.PARALLELPLAY_CONFORMANCE_PLATFORM}`
  );
}
const compatibilityPlatforms =
  platform === "linux-arm64" ? ["linux-arm64", "macos-arm64"] : [platform];
const proposedEntries = reports
  .map((report) => {
    const manifest = releaseManifests.get(report.extensionId);
    const written = outputByExtension.get(report.extensionId);
    if (!manifest || !written) throw new Error(`Incomplete evidence for ${report.extensionId}`);
    const manifestPath = join(manifestDirectory, `${report.extensionId}.extension-manifest.json`);
    writeFileSync(manifestPath, `${canonical(manifest)}\n`, { mode: 0o644 });
    return {
      extensionId: manifest.id,
      extensionVersion: manifest.extensionVersion,
      contract: manifest.contract.name,
      artifactDigest: manifest.artifact.sha256,
      artifactReference: manifest.artifact.reference,
      sourceCommit,
      conformanceReportDigest: report.reportDigest,
      conformanceEvidenceBundleDigest: fileDigest(written.evidenceBundle),
      sbomDigest: manifest.provenance.sbomDigest,
      provenanceDigest: manifest.provenance.attestationDigest,
      manifestDigest: fileDigest(manifestPath),
      platforms: compatibilityPlatforms
    };
  })
  .sort((left, right) => left.extensionId.localeCompare(right.extensionId));
const proposal = {
  schemaVersion: 1,
  suiteVersion: "0.1.0",
  releaseTag: buildManifest.releaseTag,
  sourceCommit,
  attestationBundleDigest: attestationDigest,
  entries: proposedEntries
};
const proposalPath = join(compatibilityDirectory, "first-party-proposed.json");
writeFileSync(proposalPath, `${canonical(proposal)}\n`, { mode: 0o644 });

function writeEvidenceArchive(name, directory, prefix) {
  const bytes = createTarGz(directoryEntries(directory, prefix), sourceDateEpoch);
  const path = join(releaseDirectory, name);
  writeFileSync(path, bytes, { mode: 0o644 });
  const artifactDigest = fileDigest(path);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${name} SBOM`,
    documentNamespace: `https://github.com/anirudh/parallelplay/releases/download/${buildManifest.releaseTag}/sbom/${artifactDigest}`,
    creationInfo: {
      created: new Date(sourceDateEpoch * 1000).toISOString(),
      creators: ["Tool: parallelplay-conformance-0.1.0"]
    },
    packages: [
      {
        name,
        SPDXID: "SPDXRef-Artifact",
        versionInfo: buildManifest.version,
        downloadLocation: `https://github.com/anirudh/parallelplay/releases/download/${buildManifest.releaseTag}/${name}`,
        filesAnalyzed: false,
        checksums: [{ algorithm: "SHA256", checksumValue: artifactDigest }],
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "Copyright (c) 2026 Anirudh C"
      }
    ],
    relationships: []
  };
  writeFileSync(`${path}.spdx.json`, `${canonical(sbom)}\n`, { mode: 0o644 });
  return { name, sha256: artifactDigest };
}

const evidenceArchive = writeEvidenceArchive(
  `parallelplay-conformance-evidence-${buildManifest.version}-${platform}.tar.gz`,
  output,
  `parallelplay-conformance-evidence-${buildManifest.version}`
);
const manifestArchive = writeEvidenceArchive(
  `parallelplay-extension-manifests-${buildManifest.version}-${platform}.tar.gz`,
  manifestDirectory,
  `parallelplay-extension-manifests-${buildManifest.version}`
);
const releasedProposalPath = join(
  releaseDirectory,
  `parallelplay-first-party-proposed-${buildManifest.version}-${platform}.json`
);
writeFileSync(releasedProposalPath, `${canonical(proposal)}\n`, { mode: 0o644 });
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    reports: reports.length,
    output,
    proposal: releasedProposalPath,
    evidenceArchive,
    manifestArchive
  })}\n`
);
