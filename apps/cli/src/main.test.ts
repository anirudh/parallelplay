import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const sandboxImagePath = fileURLToPath(
  new URL("../../../.parallelplay-sandbox-image", import.meta.url)
);
const schedulePath = fileURLToPath(
  new URL("../../../packages/kernel/test/fixtures/golden-schedule.json", import.meta.url)
);
const programId = "00000000-0000-4000-8000-000000000001";
const workflowId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const supervisorId = "00000000-0000-4000-8000-000000000008";
const repositoryId = "00000000-0000-4000-8000-000000000009";
const sourceRevisionId = "00000000-0000-4000-8000-000000000010";
const directories: string[] = [];

interface CliResult {
  status: number;
  stdout: unknown;
  stderr: unknown;
}

function invoke(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  const parse = (value: string): unknown => (value.trim() ? (JSON.parse(value) as unknown) : null);
  return { status: result.status ?? 1, stdout: parse(result.stdout), stderr: parse(result.stderr) };
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-cli-"));
  directories.push(directory);
  return join(directory, "parallelplay.db");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("compiled JSON CLI", () => {
  it("refuses domain commands before explicit migration", () => {
    const database = temporaryDatabase();
    const result = invoke([
      "program",
      "create",
      "--db",
      database,
      "--program-id",
      programId,
      "--name",
      "Program",
      "--idempotency-key",
      "program-1"
    ]);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatchObject({ ok: false, error: { code: "DATABASE_NOT_FOUND" } });
  });

  it("runs the real single-milestone walking skeleton through public commands", async () => {
    const database = temporaryDatabase();
    const directory = join(database, "..");
    const sourceRoot = join(directory, "source-store");
    const artifactRoot = join(directory, "artifact-store");
    const driverRoot = join(directory, "driver-store");
    const fakeDatabase = `${database}.fake`;
    const repository = join(directory, "repository");
    const taskRoot = join(directory, "task-projection");
    const singleWorkflowId = "50000000-0000-4000-8000-000000000001";
    const singleProgramId = "50000000-0000-4000-8000-000000000002";
    const milestoneId = "50000000-0000-4000-8000-000000000003";
    const singleRepositoryId = "50000000-0000-4000-8000-000000000004";
    const revisionId = "50000000-0000-4000-8000-000000000005";
    const singleRunId = "50000000-0000-4000-8000-000000000006";
    const jobId = "50000000-0000-4000-8000-000000000007";
    const workflowPath = join(directory, "single-workflow.json");
    const approvalPath = join(directory, "approval.json");
    const startPath = join(directory, "start.json");

    expect(invoke(["db", "migrate", "--db", database]).status).toBe(0);
    expect(invoke(["fake-agent", "migrate", "--fake-db", fakeDatabase]).status).toBe(0);
    expect(invoke(["source-store", "init", "--source-root", sourceRoot]).status).toBe(0);
    expect(invoke(["artifact-store", "init", "--artifact-root", artifactRoot]).status).toBe(0);
    expect(invoke(["driver-store", "init", "--driver-root", driverRoot]).status).toBe(0);
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "ParallelPlay CLI"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "cli@example.test"]);
    writeFileSync(
      join(repository, "verify.sh"),
      "#!/bin/sh\nset -eu\ngrep -q 'agent candidate' README.md\n"
    );
    writeFileSync(join(repository, "README.md"), "base\n");
    chmodSync(join(repository, "verify.sh"), 0o755);
    execFileSync("git", ["-C", repository, "add", "README.md", "verify.sh"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
    expect(
      invoke([
        "revision",
        "capture",
        "--db",
        database,
        "--source-root",
        sourceRoot,
        "--repository-id",
        singleRepositoryId,
        "--revision-id",
        revisionId,
        "--repo",
        repository,
        "--ref",
        "HEAD",
        "--idempotency-key",
        "milestone-revision"
      ]).status
    ).toBe(0);

    writeFileSync(
      workflowPath,
      `${JSON.stringify({
        schemaVersion: 2,
        workflowId: singleWorkflowId,
        version: 1,
        name: "Single workflow",
        steps: [
          {
            id: "implement",
            capability: "implementation",
            dependsOn: [],
            execution: {
              protocolVersion: 1,
              image: readFileSync(sandboxImagePath, "utf8").trim(),
              argv: ["/bin/sh", "/fixture/success.sh"],
              workingDirectory: "/workspace"
            },
            capabilities: {
              schemaVersion: 1,
              workspace: "read_write",
              artifactOutput: "read_write",
              scratch: "read_write",
              cpuLimit: 1,
              memoryLimitBytes: 268_435_456,
              pidsLimit: 64,
              network: [],
              secrets: [],
              git: []
            },
            verification: {
              mode: "verify",
              argv: ["./verify.sh"],
              cwd: ".",
              timeoutMs: 1_000,
              environment: {},
              toolProbes: []
            }
          }
        ]
      })}\n`
    );
    expect(
      invoke([
        "workflow",
        "register",
        "--db",
        database,
        "--file",
        workflowPath,
        "--idempotency-key",
        "milestone-workflow"
      ]).status
    ).toBe(0);
    writeFileSync(
      approvalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        program: {
          programId: singleProgramId,
          name: "Single milestone program",
          intent: {
            schemaVersion: 1,
            objective: "Prove the public milestone path.",
            nonGoals: ["No merge authority"],
            tenets: ["Replay", "Evidence", "Bounded authority"],
            riskClass: "normal"
          }
        },
        milestone: {
          schemaVersion: 1,
          milestoneId,
          title: "Public milestone",
          objective: "Exercise public milestone commands.",
          taskType: "feature",
          priority: "p1",
          tags: ["milestone"],
          workflowId: singleWorkflowId,
          workflowVersion: 1,
          criteria: [
            {
              criterionId: "public-path",
              statement: "The public command path records an outcome.",
              verificationStepId: "implement"
            }
          ]
        }
      })}\n`
    );
    expect(
      invoke([
        "program",
        "approve",
        "--db",
        database,
        "--file",
        approvalPath,
        "--idempotency-key",
        "milestone-approve"
      ])
    ).toMatchObject({ status: 2, stderr: { error: { code: "VALIDATION_ERROR" } } });
    expect(
      invoke([
        "program",
        "approve",
        "--db",
        database,
        "--file",
        approvalPath,
        "--actor-id",
        "operator-1",
        "--idempotency-key",
        "milestone-approve"
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, data: { status: "approved" } } });

    writeFileSync(
      startPath,
      `${JSON.stringify({
        schemaVersion: 1,
        milestoneId,
        runId: singleRunId,
        jobId,
        sourceRevisionId: revisionId,
        policy: { maxAttempts: 1, attemptTimeoutMs: 60_000, retryDelaysMs: [] }
      })}\n`
    );
    expect(
      invoke([
        "milestone",
        "start",
        "--db",
        database,
        "--file",
        startPath,
        "--actor-id",
        "operator-1",
        "--idempotency-key",
        "milestone-start"
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, data: { status: "scheduled" } } });
    expect(
      invoke(["milestone", "list", "--db", database, "--program-id", singleProgramId])
    ).toMatchObject({ status: 0, stdout: { data: [{ status: "running" }] } });
    for (let tick = 0; tick < 30; tick += 1) {
      expect(
        invoke([
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
          supervisorId
        ]).status
      ).toBe(0);
      const milestones = invoke([
        "milestone",
        "list",
        "--db",
        database,
        "--program-id",
        singleProgramId
      ]).stdout as { data: { status: string }[] };
      if (milestones.data[0]?.status === "outcome_ready") break;
    }

    const outcomeList = invoke([
      "outcome-packet",
      "list",
      "--db",
      database,
      "--program-id",
      singleProgramId
    ]);
    expect(outcomeList.status).toBe(0);
    const outcomeData = outcomeList.stdout as {
      data: {
        outcomePacketId: string;
        packet: {
          recommendation: string;
          candidateRevisionId: string | null;
          criteriaResults: { result: string }[];
        };
      }[];
    };
    const outcomePacket = outcomeData.data[0];
    if (!outcomePacket) throw new Error("missing outcome packet");
    expect(outcomePacket.packet.recommendation).toBe("merge");
    expect(typeof outcomePacket.packet.candidateRevisionId).toBe("string");
    expect(outcomePacket.packet.criteriaResults[0]?.result).toBe("pass");
    expect(
      invoke([
        "outcome-packet",
        "verify",
        "--db",
        database,
        "--outcome-packet-id",
        outcomePacket.outcomePacketId
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, valid: true } });
    expect(
      invoke(["task-projection", "render", "--db", database, "--output-root", taskRoot])
    ).toMatchObject({ status: 0, stdout: { ok: true, files: [{ milestoneId }] } });
    expect(readFileSync(join(taskRoot, `${milestoneId}.md`), "utf8")).toContain(
      "status: needs-ship"
    );
    const artifactData = invoke(["artifact", "list", "--db", database, "--run-id", singleRunId])
      .stdout as { data: { entries: { sha256: string }[] }[] };
    const evidenceDigest = artifactData.data.flatMap((manifest) => manifest.entries)[0]?.sha256;
    if (!evidenceDigest) throw new Error("missing explorer evidence artifact");

    const explorer = spawn(
      process.execPath,
      [
        cliPath,
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
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    explorer.stdout.setEncoding("utf8");
    explorer.stderr.setEncoding("utf8");
    let explorerError = "";
    explorer.stderr.on("data", (chunk: string) => {
      explorerError += chunk;
    });
    const started = await new Promise<{ url: string }>((resolvePromise, rejectPromise) => {
      let output = "";
      const timeout = setTimeout(
        () => rejectPromise(new Error("explorer start timed out")),
        10_000
      );
      explorer.stdout.on("data", (chunk: string) => {
        output += chunk;
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timeout);
        resolvePromise(JSON.parse(output.slice(0, newline)) as { url: string });
      });
      explorer.once("exit", (code) => {
        clearTimeout(timeout);
        rejectPromise(
          new Error(`explorer exited before start (${String(code)}): ${explorerError}`)
        );
      });
    });
    try {
      const explorerPage = await fetch(started.url);
      expect(explorerPage.status).toBe(200);
      expect(await explorerPage.text()).toContain("ParallelPlay execution explorer");
      const explorerSnapshot = await fetch(`${started.url}/api/snapshot`);
      expect(await explorerSnapshot.json()).toMatchObject({
        milestones: [
          {
            outcomePacket: { packet: { recommendation: "merge" } }
          }
        ]
      });
      const evidence = await fetch(`${started.url}/api/evidence/${evidenceDigest}`);
      expect(evidence.status).toBe(200);
      expect(evidence.headers.get("content-disposition")).toContain("attachment");
      expect(evidence.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      const exited = new Promise<void>((resolvePromise) =>
        explorer.once("exit", () => resolvePromise())
      );
      explorer.kill("SIGTERM");
      await exited;
    }
  }, 120_000);

  it("runs the golden lifecycle with parseable output, pagination, replay, and rebuild", () => {
    const database = temporaryDatabase();
    const directory = join(database, "..");
    const sourceRoot = join(directory, "source-store");
    const artifactRoot = join(directory, "artifact-store");
    const driverRoot = join(directory, "driver-store");
    const repository = join(directory, "repository");
    expect(invoke(["db", "status", "--db", database])).toMatchObject({
      status: 0,
      stdout: {
        ok: true,
        databaseExists: false,
        pendingVersions: [1]
      }
    });
    expect(invoke(["db", "migrate", "--db", database]).status).toBe(0);
    const fakeDatabase = `${database}.fake`;
    expect(invoke(["fake-agent", "status", "--fake-db", fakeDatabase])).toMatchObject({
      status: 0,
      stdout: { ok: true, databaseExists: false, pendingVersions: [1] }
    });
    expect(invoke(["fake-agent", "migrate", "--fake-db", fakeDatabase]).status).toBe(0);
    expect(invoke(["source-store", "init", "--source-root", sourceRoot]).status).toBe(0);
    expect(invoke(["artifact-store", "init", "--artifact-root", artifactRoot]).status).toBe(0);
    expect(invoke(["driver-store", "init", "--driver-root", driverRoot]).status).toBe(0);
    expect(invoke(["driver-store", "status", "--driver-root", driverRoot])).toMatchObject({
      status: 0,
      stdout: { ok: true, valid: true, schemaVersion: 1 }
    });
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["-C", repository, "config", "user.name", "ParallelPlay CLI"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "cli@example.test"]);
    const verifyScript = join(repository, "verify.sh");
    writeFileSync(verifyScript, "#!/bin/sh\nexit 0\n");
    chmodSync(verifyScript, 0o755);
    execFileSync("git", ["-C", repository, "add", "verify.sh"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);
    const image = readFileSync(sandboxImagePath, "utf8").trim();
    expect(invoke(["sandbox", "preflight", "--image", image])).toMatchObject({
      status: 0,
      stdout: { ok: true, imageAvailable: true }
    });
    const workflowPath = join(directory, "workflow-v2.json");
    const execution = {
      protocolVersion: 1,
      image,
      argv: ["/bin/sh", "/fixture/success.sh"],
      workingDirectory: "/workspace"
    };
    const capabilities = {
      schemaVersion: 1,
      workspace: "read_write",
      artifactOutput: "read_write",
      scratch: "read_write",
      cpuLimit: 1,
      memoryLimitBytes: 268435456,
      pidsLimit: 64,
      network: [],
      secrets: [],
      git: []
    };
    const verification = {
      mode: "verify",
      argv: ["./verify.sh"],
      cwd: ".",
      timeoutMs: 1000,
      environment: {},
      toolProbes: []
    };
    writeFileSync(
      workflowPath,
      `${JSON.stringify({
        schemaVersion: 2,
        workflowId,
        version: 1,
        name: "Golden workflow",
        steps: [
          {
            id: "plan",
            capability: "planning",
            dependsOn: [],
            execution,
            capabilities,
            verification
          },
          {
            id: "build",
            capability: "implementation",
            dependsOn: ["plan"],
            execution,
            capabilities,
            verification
          }
        ]
      })}\n`
    );

    const programArgs = [
      "program",
      "create",
      "--db",
      database,
      "--program-id",
      programId,
      "--name",
      "Golden program",
      "--idempotency-key",
      "program-1"
    ];
    const firstProgram = invoke(programArgs);
    const replayedProgram = invoke(programArgs);
    expect(firstProgram).toMatchObject({ status: 0, stdout: { ok: true, replayed: false } });
    expect(replayedProgram).toMatchObject({ status: 0, stdout: { ok: true, replayed: true } });

    expect(
      invoke([
        "revision",
        "capture",
        "--db",
        database,
        "--source-root",
        sourceRoot,
        "--repository-id",
        repositoryId,
        "--revision-id",
        sourceRevisionId,
        "--repo",
        repository,
        "--ref",
        "HEAD",
        "--idempotency-key",
        "revision-1"
      ]).status
    ).toBe(0);

    expect(
      invoke([
        "workflow",
        "register",
        "--db",
        database,
        "--file",
        workflowPath,
        "--idempotency-key",
        "workflow-1"
      ]).status
    ).toBe(0);
    expect(
      invoke([
        "run",
        "create",
        "--db",
        database,
        "--run-id",
        runId,
        "--program-id",
        programId,
        "--workflow-id",
        workflowId,
        "--workflow-version",
        "1",
        "--idempotency-key",
        "run-1"
      ]).status
    ).toBe(0);
    expect(
      invoke([
        "run",
        "schedule",
        "--db",
        database,
        "--file",
        schedulePath,
        "--idempotency-key",
        "schedule-1"
      ]).status
    ).toBe(0);

    const firstPage = invoke(["events", "list", "--db", database, "--limit", "2"]);
    expect(firstPage).toMatchObject({
      status: 0,
      stdout: { ok: true, nextPosition: 2, events: [{ globalPosition: 1 }, { globalPosition: 2 }] }
    });

    for (let tick = 0; tick < 20; tick += 1) {
      expect(
        invoke([
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
          supervisorId
        ]).status
      ).toBe(0);
    }
    expect(invoke(["projection", "verify", "--db", database])).toMatchObject({
      status: 0,
      stdout: { ok: true, valid: true, projectionSchemaVersion: 1 }
    });
    expect(invoke(["projection", "rebuild", "--db", database])).toMatchObject({
      status: 0,
      stdout: { ok: true, projectionSchemaVersion: 1 }
    });
    expect(
      invoke(["state", "show", "--db", database, "--kind", "run", "--id", runId])
    ).toMatchObject({
      status: 0,
      stdout: { ok: true, data: { status: "succeeded" } }
    });
    expect(invoke(["job", "list", "--db", database, "--run-id", runId])).toMatchObject({
      status: 0,
      stdout: { ok: true, data: [{ status: "succeeded" }, { status: "succeeded" }] }
    });
    expect(invoke(["outbox", "list", "--db", database, "--run-id", runId])).toMatchObject({
      status: 0,
      stdout: {
        ok: true,
        data: [
          { status: "delivered" },
          { status: "delivered" },
          { status: "delivered" },
          { status: "delivered" }
        ]
      }
    });
    expect(invoke(["revision", "list", "--db", database])).toMatchObject({ status: 0 });
    const revisions = invoke(["revision", "list", "--db", database]).stdout as {
      data: { revisionId: string }[];
    };
    expect(revisions.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ revisionId: sourceRevisionId })])
    );
    expect(revisions.data).toHaveLength(3);
    expect(
      invoke(["revision", "show", "--db", database, "--revision-id", sourceRevisionId])
    ).toMatchObject({ status: 0, stdout: { ok: true, data: { revisionId: sourceRevisionId } } });
    const verificationList = invoke(["verification", "list", "--db", database, "--run-id", runId]);
    expect(verificationList).toMatchObject({
      status: 0,
      stdout: { ok: true, data: [{ status: "passed" }, { status: "passed" }] }
    });
    const verificationData = verificationList.stdout as {
      data: { verificationId: string; artifactManifestId: string }[];
    };
    const firstVerification = verificationData.data[0];
    if (!firstVerification) throw new Error("missing CLI verification result");
    const driverReceipts = invoke(["driver-receipt", "list", "--db", database, "--run-id", runId]);
    expect(driverReceipts).toMatchObject({
      status: 0,
      stdout: { ok: true, data: [{ outcome: "succeeded" }, { outcome: "succeeded" }] }
    });
    const receiptData = driverReceipts.stdout as { data: { driverReceiptId: string }[] };
    const firstDriverReceipt = receiptData.data[0];
    if (!firstDriverReceipt) throw new Error("missing CLI driver receipt");
    expect(
      invoke([
        "driver-receipt",
        "show",
        "--db",
        database,
        "--driver-receipt-id",
        firstDriverReceipt.driverReceiptId
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, data: { outcome: "succeeded" } } });
    expect(
      invoke([
        "evidence",
        "verify",
        "--db",
        database,
        "--source-root",
        sourceRoot,
        "--artifact-root",
        artifactRoot,
        "--driver-receipt-id",
        firstDriverReceipt.driverReceiptId
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, valid: true } });
    expect(invoke(["approval-request", "list", "--db", database, "--run-id", runId])).toMatchObject(
      {
        status: 0,
        stdout: { ok: true, data: [] }
      }
    );
    expect(
      invoke([
        "verification",
        "verify",
        "--db",
        database,
        "--source-root",
        sourceRoot,
        "--artifact-root",
        artifactRoot,
        "--verification-id",
        firstVerification.verificationId
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, valid: true } });
    expect(invoke(["artifact", "list", "--db", database, "--run-id", runId])).toMatchObject({
      status: 0,
      stdout: { ok: true, data: [{}, {}, {}, {}] }
    });
    expect(
      invoke([
        "artifact",
        "verify",
        "--db",
        database,
        "--artifact-root",
        artifactRoot,
        "--artifact-manifest-id",
        firstVerification.artifactManifestId
      ])
    ).toMatchObject({ status: 0, stdout: { ok: true, failures: [] } });
    const traceResult = invoke(["trace", "show", "--db", database, "--run-id", runId]);
    expect(traceResult).toMatchObject({
      status: 0,
      stdout: { ok: true, data: { traceId: runId } }
    });
    const traceData = traceResult.stdout as {
      data: { records: { type: string; status?: string }[] };
    };
    expect(traceData.data.records.some((record) => record.type === "VerificationRequested")).toBe(
      true
    );
    expect(
      traceData.data.records.some(
        (record) => record.type === "VerificationReceiptRecorded" && record.status === "passed"
      )
    ).toBe(true);
    expect(
      traceData.data.records.some(
        (record) =>
          record.type === "DriverReceiptRecorded" &&
          typeof (record as { candidateRevisionId?: unknown }).candidateRevisionId === "string"
      )
    ).toBe(true);
    expect(
      invoke([
        "supervisor",
        "run",
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
        supervisorId,
        "--max-ticks",
        "1"
      ])
    ).toMatchObject({ status: 0, stdout: { action: "supervisor_stopped", ticks: 1 } });
  }, 120_000);

  it("shuts down the polling supervisor gracefully on SIGTERM", async () => {
    const database = temporaryDatabase();
    const fakeDatabase = `${database}.fake`;
    const sourceRoot = `${database}.source`;
    const artifactRoot = `${database}.artifacts`;
    const driverRoot = `${database}.driver`;
    expect(invoke(["db", "migrate", "--db", database]).status).toBe(0);
    expect(invoke(["fake-agent", "migrate", "--fake-db", fakeDatabase]).status).toBe(0);
    expect(invoke(["source-store", "init", "--source-root", sourceRoot]).status).toBe(0);
    expect(invoke(["artifact-store", "init", "--artifact-root", artifactRoot]).status).toBe(0);
    expect(invoke(["driver-store", "init", "--driver-root", driverRoot]).status).toBe(0);
    const child = spawn(
      process.execPath,
      [
        cliPath,
        "supervisor",
        "run",
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
        supervisorId
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGTERM");
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim()) as unknown).toMatchObject({
      action: "supervisor_stopped",
      supervisorId
    });
  });
});
