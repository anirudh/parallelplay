import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase, openKernel, type Clock, type Kernel } from "@parallelplay/kernel";
import { FileArtifactStore, initializeArtifactStore } from "./artifact-store.js";
import { DriverRegistry } from "./driver.js";
import {
  GenericCommandDriver,
  dockerPreflight,
  initializeDriverStore,
  parseDriverJsonl,
  type GenericDriverFaultPoint
} from "./generic-command-driver.js";
import { ManagedGitRevisionStore, initializeSourceStore } from "./source-store.js";
import { Supervisor } from "./supervisor.js";
import { TrustedCommandVerifier } from "./verifier.js";
import { verifyDriverEvidence } from "./evidence.js";

const programId = "10000000-0000-4000-8000-000000000001";
const workflowId = "10000000-0000-4000-8000-000000000002";
const runId = "10000000-0000-4000-8000-000000000003";
const jobId = "10000000-0000-4000-8000-000000000004";
const repositoryId = "10000000-0000-4000-8000-000000000005";
const baseRevisionId = "10000000-0000-4000-8000-000000000006";
const supervisorId = "10000000-0000-4000-8000-000000000007";
const milestoneId = "10000000-0000-4000-8000-000000000008";
const directories: string[] = [];
const describeWithPreparedSandbox = existsSync(resolve(".parallelplay-sandbox-image"))
  ? describe
  : describe.skip;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureImage(): string {
  const image = readFileSync(resolve(".parallelplay-sandbox-image"), "utf8").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Run pnpm sandbox:prepare first");
  return image;
}

async function createRun(
  argv: string[],
  verifierScript = "#!/bin/sh\nset -eu\ngrep -q 'agent candidate' README.md\n",
  options: {
    clock?: Clock;
    attemptTimeoutMs?: number;
    faultInjector?: (point: GenericDriverFaultPoint) => void;
    milestone?: boolean;
  } = {}
): Promise<{
  kernel: Kernel;
  driver: GenericCommandDriver;
  artifacts: FileArtifactStore;
  source: ManagedGitRevisionStore;
  repository: string;
  databasePath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "parallelplay-generic-driver-"));
  directories.push(root);
  const repository = join(root, "repository");
  const sourceRoot = join(root, "source");
  const artifactRoot = join(root, "artifacts");
  const driverRoot = join(root, "driver");
  const databasePath = join(root, "parallelplay.db");
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "ParallelPlay Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "parallelplay@example.test"]);
  writeFileSync(join(repository, "README.md"), "base\n");
  writeFileSync(join(repository, "verify.sh"), verifierScript);
  chmodSync(join(repository, "verify.sh"), 0o755);
  execFileSync("git", ["-C", repository, "add", "README.md", "verify.sh"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "base"]);
  initializeSourceStore(sourceRoot);
  initializeArtifactStore(artifactRoot);
  initializeDriverStore(driverRoot);
  const source = new ManagedGitRevisionStore(sourceRoot);
  const artifacts = new FileArtifactStore(artifactRoot);
  const captured = await source.capture({
    repositoryId,
    revisionId: baseRevisionId,
    captureKey: "generic-base",
    repositoryPath: repository,
    ref: "HEAD"
  });
  await migrateDatabase({ databasePath });
  const kernel = await openKernel({
    databasePath,
    ...(options.clock ? { clock: options.clock } : {})
  });
  const image = fixtureImage();
  const execution = {
    protocolVersion: 1 as const,
    image,
    argv,
    workingDirectory: "/workspace" as const
  };
  const capabilities = {
    schemaVersion: 1 as const,
    workspace: "read_write" as const,
    artifactOutput: "read_write" as const,
    scratch: "read_write" as const,
    cpuLimit: 1,
    memoryLimitBytes: 268_435_456,
    pidsLimit: 64,
    network: [] as [],
    secrets: [] as [],
    git: [] as []
  };
  const verification = {
    mode: "verify" as const,
    argv: ["./verify.sh"],
    cwd: "." as const,
    timeoutMs: Math.min(10_000, options.attemptTimeoutMs ?? 60_000),
    environment: {},
    toolProbes: []
  };
  const actor = { kind: "operator", id: "generic-driver-test" } as const;
  const workflowDefinition = {
    schemaVersion: 2 as const,
    workflowId,
    version: 1,
    name: "Generic command workflow",
    steps: [
      {
        id: "execute",
        capability: "implementation",
        dependsOn: [],
        execution,
        capabilities,
        verification
      }
    ]
  };
  const setupCommands = options.milestone
    ? [
        {
          type: "source-revision.register" as const,
          idempotencyKey: "generic-revision",
          actor,
          payload: captured
        },
        {
          type: "workflow.register" as const,
          idempotencyKey: "generic-workflow",
          actor,
          payload: workflowDefinition
        },
        {
          type: "program.approve" as const,
          idempotencyKey: "generic-approve",
          actor,
          payload: {
            schemaVersion: 1 as const,
            program: {
              programId,
              name: "Generic driver milestone",
              intent: {
                schemaVersion: 1 as const,
                objective: "Produce one verified candidate revision.",
                nonGoals: ["No merge authority"],
                tenets: ["Replay", "Evidence", "Bounded authority"],
                riskClass: "normal" as const
              }
            },
            milestone: {
              schemaVersion: 1 as const,
              milestoneId,
              title: "Produce a candidate",
              objective: "Change and verify one tracked file.",
              taskType: "feature" as const,
              priority: "p1" as const,
              tags: ["milestone", "walking-skeleton"],
              workflowId,
              workflowVersion: 1,
              criteria: [
                {
                  criterionId: "candidate-verifies",
                  statement: "The candidate passes the registered verifier.",
                  verificationStepId: "execute"
                }
              ]
            }
          }
        },
        {
          type: "milestone.start" as const,
          idempotencyKey: "generic-milestone-start",
          actor,
          payload: {
            schemaVersion: 1 as const,
            milestoneId,
            runId,
            jobId,
            sourceRevisionId: baseRevisionId,
            policy: {
              maxAttempts: 1,
              attemptTimeoutMs: options.attemptTimeoutMs ?? 60_000,
              retryDelaysMs: []
            }
          }
        }
      ]
    : [
        {
          type: "program.create" as const,
          idempotencyKey: "generic-program",
          actor,
          payload: { programId, name: "Generic driver" }
        },
        {
          type: "source-revision.register" as const,
          idempotencyKey: "generic-revision",
          actor,
          payload: captured
        },
        {
          type: "workflow.register" as const,
          idempotencyKey: "generic-workflow",
          actor,
          payload: workflowDefinition
        },
        {
          type: "run.create" as const,
          idempotencyKey: "generic-run",
          actor,
          payload: { runId, programId, workflowId, workflowVersion: 1 }
        },
        {
          type: "run.schedule" as const,
          idempotencyKey: "generic-schedule",
          actor,
          payload: {
            runId,
            jobs: [
              {
                jobId,
                stepId: "execute",
                sourceRevisionId: baseRevisionId,
                policy: {
                  maxAttempts: 1,
                  attemptTimeoutMs: options.attemptTimeoutMs ?? 60_000,
                  retryDelaysMs: []
                }
              }
            ]
          }
        }
      ];
  for (const command of setupCommands) {
    const result = await kernel.execute(command);
    expect(result, `${command.type}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
  }
  const driver = new GenericCommandDriver({
    root: driverRoot,
    sourceStore: source,
    artifactStore: artifacts,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {})
  });
  return { kernel, driver, artifacts, source, repository, databasePath };
}

describeWithPreparedSandbox("generic command driver", { timeout: 60_000 }, () => {
  it("strictly parses ordered JSONL and rejects unknown fields and sequence gaps", () => {
    expect(
      parseDriverJsonl(
        '{"schemaVersion":1,"sequence":1,"type":"started"}\n' +
          '{"schemaVersion":1,"sequence":2,"type":"terminal","outcome":"succeeded"}\n'
      )
    ).toHaveLength(2);
    expect(() => parseDriverJsonl('{"schemaVersion":1,"sequence":2,"type":"started"}\n')).toThrow(
      "sequence 1"
    );
    expect(() =>
      parseDriverJsonl('{"schemaVersion":1,"sequence":1,"type":"started","extra":true}\n')
    ).toThrow();
    expect(() => parseDriverJsonl("{not-json}\n")).toThrow("not valid JSON");
    expect(() =>
      parseDriverJsonl(
        '{"schemaVersion":1,"sequence":1,"type":"started"}\n' +
          '{"schemaVersion":1,"sequence":1,"type":"terminal","outcome":"succeeded"}\n'
      )
    ).toThrow("sequence 2");
    expect(() =>
      parseDriverJsonl(
        '{"schemaVersion":1,"sequence":1,"type":"started"}\n\n' +
          '{"schemaVersion":1,"sequence":2,"type":"terminal","outcome":"succeeded"}\n'
      )
    ).toThrow("blank line");
    expect(() =>
      parseDriverJsonl(
        '{"schemaVersion":1,"sequence":1,"type":"started"}\n' +
          '{"schemaVersion":1,"sequence":2,"type":"terminal","outcome":"succeeded"}\n' +
          '{"schemaVersion":1,"sequence":3,"type":"terminal","outcome":"failed"}\n'
      )
    ).toThrow("after terminal");
    expect(() =>
      parseDriverJsonl(
        '{"schemaVersion":1,"sequence":1,"type":"artifact.declared","path":"../escape","role":"agent.output"}\n'
      )
    ).toThrow();
  });

  it("preflights only the prepared local Linux image", async () => {
    expect(await dockerPreflight(fixtureImage())).toMatchObject({
      ok: true,
      imageAvailable: true
    });
  });

  it("captures an immutable candidate and verifies that exact revision", async () => {
    const { kernel, driver, artifacts, source, repository } = await createRun(
      ["/bin/sh", "/fixture/success.sh"],
      "#!/bin/sh\nset -eu\ngrep -q 'agent candidate' README.md\n! grep -q 'branch moved' README.md\n"
    );
    writeFileSync(join(repository, "README.md"), "branch moved\n");
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "move branch after capture"]);
    const records: unknown[] = [];
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({
        sourceStore: source,
        artifactStore: artifacts
      }),
      supervisorId,
      onRecord: (record) => records.push(record)
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(
        await kernel.getState({ kind: "run", id: runId }),
        JSON.stringify(records)
      ).toMatchObject({
        status: "succeeded"
      });
      const job = await kernel.getState({ kind: "job", id: jobId });
      expect(job).toMatchObject({ status: "succeeded" });
      if (job?.kind !== "job" || !job.candidateRevisionId)
        throw new Error("missing candidate revision");
      expect(job.candidateRevisionId).not.toBe(baseRevisionId);
      const receipts = await kernel.listDriverReceipts({ runId });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: "succeeded",
        baseRevisionId,
        candidateRevisionId: job.candidateRevisionId
      });
      expect(artifacts.verify(receipts[0]?.receipt.artifacts ?? [])).toEqual({
        valid: true,
        failures: []
      });
      if (!receipts[0]) throw new Error("missing driver receipt");
      expect(
        await verifyDriverEvidence({
          kernel,
          sourceStore: source,
          artifactStore: artifacts,
          driverReceiptId: receipts[0].driverReceiptId
        })
      ).toEqual({
        driverReceiptId: receipts[0].driverReceiptId,
        valid: true,
        failures: []
      });
      expect(await kernel.listArtifactManifests({ runId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ producer: "agent", sourceRevisionId: job.candidateRevisionId }),
          expect.objectContaining({
            producer: "verifier",
            sourceRevisionId: job.candidateRevisionId
          })
        ])
      );
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
      const protocolArtifact = receipts[0].receipt.artifacts.find(
        (entry) => entry.path === "driver/protocol.jsonl"
      );
      if (!protocolArtifact) throw new Error("missing protocol artifact");
      writeFileSync(artifacts.objectPath(protocolArtifact.sha256), "tampered\n");
      expect(
        await verifyDriverEvidence({
          kernel,
          sourceStore: source,
          artifactStore: artifacts,
          driverReceiptId: receipts[0].driverReceiptId
        })
      ).toMatchObject({ valid: false });
    } finally {
      await driver.close();
      await kernel.close();
    }
  }, 60_000);

  it("produces one verified merge packet for a real single-step milestone", async () => {
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/success.sh"],
      "#!/bin/sh\nset -eu\ngrep -q 'agent candidate' README.md\n",
      { milestone: true }
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const milestone = await kernel.getState({ kind: "milestone", id: milestoneId });
        if (milestone?.kind === "milestone" && milestone.status === "outcome_ready") break;
      }
      const packets = await kernel.listOutcomePackets(programId);
      expect(packets).toHaveLength(1);
      const packet = packets[0];
      if (!packet) throw new Error("missing outcome packet");
      expect(packet.packet).toMatchObject({
        recommendation: "merge",
        baseRevisionId,
        criteriaResults: [{ criterionId: "candidate-verifies", result: "pass" }]
      });
      expect(packet.packet.candidateRevisionId).not.toBeNull();
      expect(packet.packet.driverReceipts).toHaveLength(1);
      expect(packet.packet.verificationReceipts).toHaveLength(1);
      expect(packet.packet.artifactManifests).toHaveLength(2);
      expect(await kernel.verifyOutcomePacket(packet.outcomePacketId)).toMatchObject({
        valid: true,
        failures: []
      });
      expect(await kernel.getMilestoneSnapshot(milestoneId)).toMatchObject({
        milestone: { status: "outcome_ready", recommendation: "merge" },
        run: { status: "succeeded" },
        outcomePacket: { outcomePacketId: packet.outcomePacketId }
      });
      const trace = await kernel.getExecutionTrace(runId);
      expect(trace?.records.map((record) => record.type)).toEqual(
        expect.arrayContaining(["OutcomePacketRecorded", "MilestoneOutcomeReady"])
      );
      const verifiedBeforeRebuild = await kernel.verifyProjections();
      expect(verifiedBeforeRebuild).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
      expect((await kernel.rebuildProjections()).rebuiltDigest).toBe(
        verifiedBeforeRebuild.replayedDigest
      );
      expect(await kernel.verifyProjections()).toMatchObject({ valid: true });
      expect(await kernel.getState({ kind: "outcome_packet", id: packet.outcomePacketId })).toEqual(
        packet
      );
      expect(await kernel.verifyOutcomePacket(packet.outcomePacketId)).toMatchObject({
        valid: true,
        failures: []
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  }, 60_000);

  it("enforces the declared mounts and denies ambient host, Git, socket, root, and network access", async () => {
    const hostMarker = join(tmpdir(), "parallelplay-operator-home-marker");
    writeFileSync(hostMarker, "must remain host-only\n");
    const priorSecret = process.env["PARALLELPLAY_TEST_HOST_SECRET"];
    process.env["PARALLELPLAY_TEST_HOST_SECRET"] = "must-not-cross-the-boundary";
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/containment.sh"],
      "#!/bin/sh\nexit 0\n"
    );
    const records: unknown[] = [];
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId,
      onRecord: (record) => records.push(record)
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(
        await kernel.getState({ kind: "run", id: runId }),
        JSON.stringify(records)
      ).toMatchObject({
        status: "succeeded"
      });
      const receipt = (await kernel.listDriverReceipts({ runId }))[0];
      const containment = receipt?.receipt.artifacts.find(
        (entry) => entry.path === "agent/containment.json"
      );
      if (!containment) throw new Error("missing containment artifact");
      expect(JSON.parse(readFileSync(artifacts.objectPath(containment.sha256), "utf8"))).toEqual({
        homeHidden: true,
        markerHidden: true,
        hostSecretHidden: true,
        credentialsHidden: true,
        gitHidden: true,
        socketHidden: true,
        rootReadOnly: true,
        networkBlocked: true,
        workspaceWrite: true,
        artifactWrite: true,
        scratchWrite: true
      });
    } finally {
      if (priorSecret === undefined) delete process.env["PARALLELPLAY_TEST_HOST_SECRET"];
      else process.env["PARALLELPLAY_TEST_HOST_SECRET"] = priorSecret;
      rmSync(hostMarker, { force: true });
      await driver.close();
      await kernel.close();
    }
  });

  it("records approval requests and terminates without treating them as success", async () => {
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/approval.sh"],
      "#!/bin/sh\nexit 0\n"
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.listApprovalRequests({ runId })).toEqual([
        expect.objectContaining({
          capability: "network.http",
          reason: "fixture requires public network"
        })
      ]);
      expect(await kernel.listDriverReceipts({ runId })).toEqual([
        expect.objectContaining({ outcome: "approval_required" })
      ]);
      const attempts = (await kernel.listEvents()).events.filter(
        (event) => event.type === "AttemptFinished"
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.data).toMatchObject({
        status: "approval_required",
        terminationReason: "approval_required"
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("turns malformed stdout into a nonretryable protocol-invalid receipt", async () => {
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/malformed.sh"],
      "#!/bin/sh\nexit 0\n"
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.listDriverReceipts({ runId })).toEqual([
        expect.objectContaining({ outcome: "protocol_invalid" })
      ]);
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it.each([
    ["explicit failure", "/fixture/failure.sh", "failed"],
    ["undeclared capability", "/fixture/capability-violation.sh", "capability_violation"],
    ["missing terminal", "/fixture/missing-terminal.sh", "protocol_invalid"],
    ["exit and terminal disagreement", "/fixture/success-nonzero.sh", "protocol_invalid"],
    ["symlink artifact", "/fixture/artifact-symlink.sh", "protocol_invalid"]
  ])("records %s as %s", async (_label, fixture, expectedOutcome) => {
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", fixture],
      "#!/bin/sh\nexit 0\n"
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      for (let tick = 0; tick < 30; tick += 1) {
        await supervisor.tick();
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.listDriverReceipts({ runId })).toEqual([
        expect.objectContaining({ outcome: expectedOutcome })
      ]);
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("records operator cancellation and removes the whole container process tree", async () => {
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/hang.sh"],
      "#!/bin/sh\nexit 0\n"
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      for (let tick = 0; tick < 3; tick += 1) await supervisor.tick();
      const job = await kernel.getState({ kind: "job", id: jobId });
      if (job?.kind !== "job" || !job.activeAttemptId) throw new Error("missing running attempt");
      const attempt = await kernel.getState({ kind: "attempt", id: job.activeAttemptId });
      expect(attempt).toMatchObject({ status: "running" });
      if (attempt?.kind !== "attempt" || !attempt.externalRunId)
        throw new Error("missing external run");
      const containerName = `parallelplay-${attempt.externalRunId.slice("docker:".length)}`;
      expect(
        await kernel.execute({
          type: "run.cancel",
          idempotencyKey: "generic-operator-cancel",
          actor: { kind: "operator", id: "generic-driver-test" },
          payload: { runId, reason: "operator requested cancellation" }
        })
      ).toMatchObject({ ok: true });
      for (let tick = 0; tick < 5; tick += 1) await supervisor.tick();
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({
        status: "cancelled"
      });
      expect(await kernel.listDriverReceipts({ runId })).toEqual([
        expect.objectContaining({ outcome: "operator_cancelled" })
      ]);
      const trace = await kernel.getExecutionTrace(runId);
      expect(
        trace?.records.some((record) => record.terminationReason === "operator_cancelled")
      ).toBe(true);
      expect(trace?.records.some((record) => record.type === "DriverReceiptRecorded")).toBe(true);
      expect(() =>
        execFileSync("docker", ["inspect", containerName], { stdio: "ignore" })
      ).toThrow();
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("converges after a crash following durable receipt persistence", async () => {
    let inject = true;
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/success.sh"],
      "#!/bin/sh\nset -eu\ngrep -q 'agent candidate' README.md\n",
      {
        milestone: true,
        faultInjector: (point) => {
          if (point === "after-receipt-persist" && inject) {
            inject = false;
            throw new Error("injected crash after durable receipt");
          }
        }
      }
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId
    });
    try {
      let observedCrash = false;
      for (let tick = 0; tick < 30; tick += 1) {
        try {
          await supervisor.tick();
        } catch (error) {
          expect(error).toMatchObject({ message: "injected crash after durable receipt" });
          observedCrash = true;
        }
        const run = await kernel.getState({ kind: "run", id: runId });
        if (run?.kind === "run" && ["succeeded", "failed", "cancelled"].includes(run.status)) break;
      }
      expect(observedCrash).toBe(true);
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({
        status: "succeeded"
      });
      expect(await kernel.listDriverReceipts({ runId })).toHaveLength(1);
      expect(
        (await kernel.listSourceRevisions()).filter(
          (revision) => revision.revisionId !== baseRevisionId
        )
      ).toHaveLength(1);
      const packets = await kernel.listOutcomePackets(programId);
      expect(packets).toHaveLength(1);
      const packet = packets[0];
      if (!packet) throw new Error("missing recovered outcome packet");
      expect(packet.packet.recommendation).toBe("merge");
      expect(await kernel.verifyOutcomePacket(packet.outcomePacketId)).toMatchObject({
        valid: true,
        failures: []
      });
    } finally {
      await driver.close();
      await kernel.close();
    }
  });

  it("preserves a timed-out outcome after Docker reports cancellation", async () => {
    let current = new Date("2026-08-20T20:00:00.000Z");
    const clock: Clock = { now: () => current };
    const { kernel, driver, artifacts, source } = await createRun(
      ["/bin/sh", "/fixture/hang.sh"],
      "#!/bin/sh\nexit 0\n",
      { clock, attemptTimeoutMs: 1_000 }
    );
    const supervisor = new Supervisor({
      kernel,
      drivers: new DriverRegistry([driver]),
      verifier: new TrustedCommandVerifier({ sourceStore: source, artifactStore: artifacts }),
      supervisorId,
      clock
    });
    try {
      for (let tick = 0; tick < 3; tick += 1) await supervisor.tick();
      current = new Date("2026-08-20T20:00:02.000Z");
      for (let tick = 0; tick < 6; tick += 1) await supervisor.tick();
      expect(await kernel.getState({ kind: "run", id: runId })).toMatchObject({ status: "failed" });
      expect(await kernel.listDriverReceipts({ runId })).toEqual([
        expect.objectContaining({ outcome: "timed_out", terminalReason: "timed_out" })
      ]);
      const trace = await kernel.getExecutionTrace(runId);
      expect(trace?.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ terminationReason: "timed_out" }),
          expect.objectContaining({ type: "DriverReceiptRecorded" })
        ])
      );
    } finally {
      await driver.close();
      await kernel.close();
    }
  });
});
