import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { OutcomePacketV1Schema } from "./schema.js";
import type { MilestoneState, OutcomePacketState, ProgramState } from "./schema.js";
import { renderTaskProjection } from "./task-projection.js";

const programId = "30000000-0000-4000-8000-000000000001";
const milestoneId = "30000000-0000-4000-8000-000000000002";
const workflowId = "30000000-0000-4000-8000-000000000003";
const runId = "30000000-0000-4000-8000-000000000004";
const jobId = "30000000-0000-4000-8000-000000000005";
const packetId = "30000000-0000-4000-8000-000000000006";
const timestamp = "2026-08-20T12:00:00.000Z";
const digest = "a".repeat(64);

const program: ProgramState = {
  kind: "program",
  programId,
  name: "Projection program",
  status: "active",
  intent: {
    schemaVersion: 1,
    objective: "Project one approved milestone.",
    nonGoals: [],
    tenets: ["Replay", "Evidence", "Bounded authority"],
    riskClass: "normal"
  },
  intentDigest: digest,
  approvedBy: "operator-1",
  approvedAt: timestamp,
  createdAt: timestamp,
  version: 2
};

const approved: MilestoneState = {
  kind: "milestone",
  milestoneId,
  programId,
  contract: {
    schemaVersion: 1,
    milestoneId,
    title: "Render projection",
    objective: "Produce deterministic task Markdown.",
    taskType: "feature",
    priority: "p1",
    tags: ["milestone", "projection"],
    workflowId,
    workflowVersion: 1,
    criteria: [
      {
        criterionId: "projection-stable",
        statement: "The task projection is byte stable.",
        verificationStepId: "implement"
      }
    ]
  },
  contractDigest: digest,
  workflowDigest: "b".repeat(64),
  status: "approved",
  runId: null,
  jobId: null,
  baseRevisionId: null,
  outcomePacketId: null,
  recommendation: null,
  approvedBy: "operator-1",
  approvedAt: timestamp,
  startedAt: null,
  completedAt: null,
  version: 1
};

function outcome(recommendation: "merge" | "reject" | "investigate"): OutcomePacketState {
  const criterionResult =
    recommendation === "merge" ? "pass" : recommendation === "reject" ? "fail" : "unverified";
  return {
    kind: "outcome_packet",
    outcomePacketId: packetId,
    programId,
    milestoneId,
    runId,
    packet: {
      schemaVersion: 1,
      packetVersion: 1,
      outcomePacketId: packetId,
      programId,
      milestoneId,
      runId,
      baseRevisionId: "30000000-0000-4000-8000-000000000007",
      candidateRevisionId:
        recommendation === "merge" ? "30000000-0000-4000-8000-000000000008" : null,
      intentDigest: digest,
      milestoneContractDigest: digest,
      workflowDigest: "b".repeat(64),
      criteriaResults: [
        {
          criterionId: "projection-stable",
          statement: "The task projection is byte stable.",
          result: criterionResult,
          evidenceRefs: []
        }
      ],
      attemptHistory: [],
      driverReceipts: [],
      verificationReceipts: [],
      artifactManifests: [],
      capabilitiesUsed: [],
      terminalReason: recommendation === "merge" ? "verified_success" : "terminal_failure",
      summary: `${recommendation} summary`,
      deviationReasons: recommendation === "merge" ? [] : ["terminal_failure"],
      recommendation,
      humanEvidenceFocus: ["Review the evidence."],
      generatedAt: timestamp
    },
    packetDigest: "c".repeat(64),
    recordedAt: timestamp,
    version: 1
  };
}

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "parallelplay-task-projection-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("task projection", () => {
  it("is byte stable, preserves unrelated files, and removes only previously owned stale files", () => {
    const root = directory();
    writeFileSync(join(root, "operator-notes.txt"), "keep me\n");
    const first = renderTaskProjection({
      outputRoot: root,
      programs: [program],
      milestones: [approved],
      outcomePackets: []
    });
    const taskPath = join(root, `${milestoneId}.md`);
    const firstTask = readFileSync(taskPath, "utf8");
    const firstManifest = readFileSync(first.ownershipManifest, "utf8");
    expect(firstTask).toContain("status: todo");
    expect(firstTask).toContain("## Criteria");

    renderTaskProjection({
      outputRoot: root,
      programs: [program],
      milestones: [approved],
      outcomePackets: []
    });
    expect(readFileSync(taskPath, "utf8")).toBe(firstTask);
    expect(readFileSync(first.ownershipManifest, "utf8")).toBe(firstManifest);

    const emptied = renderTaskProjection({
      outputRoot: root,
      programs: [program],
      milestones: [],
      outcomePackets: []
    });
    expect(emptied.removed).toEqual([`${milestoneId}.md`]);
    expect(existsSync(taskPath)).toBe(false);
    expect(readFileSync(join(root, "operator-notes.txt"), "utf8")).toBe("keep me\n");
  });

  it.each([
    ["merge", "needs-ship"],
    ["reject", "blocked"],
    ["investigate", "blocked"]
  ] as const)("maps a %s packet to %s", (recommendation, status) => {
    const root = directory();
    const completed: MilestoneState = {
      ...approved,
      status: "outcome_ready",
      runId,
      jobId,
      baseRevisionId: "30000000-0000-4000-8000-000000000007",
      outcomePacketId: packetId,
      recommendation,
      startedAt: timestamp,
      completedAt: timestamp,
      version: 3
    };
    renderTaskProjection({
      outputRoot: root,
      programs: [program],
      milestones: [completed],
      outcomePackets: [outcome(recommendation)]
    });
    expect(readFileSync(join(root, `${milestoneId}.md`), "utf8")).toContain(`status: ${status}`);
  });

  it("refuses manifest tampering, symlink traversal, and source-repository roots", () => {
    const root = directory();
    const rendered = renderTaskProjection({
      outputRoot: root,
      programs: [program],
      milestones: [approved],
      outcomePackets: []
    });
    writeFileSync(rendered.ownershipManifest, "{}\n");
    expect(() =>
      renderTaskProjection({
        outputRoot: root,
        programs: [program],
        milestones: [approved],
        outcomePackets: []
      })
    ).toThrow();

    const parent = directory();
    const target = join(parent, "target");
    mkdirSync(target);
    const link = join(parent, "linked-root");
    symlinkSync(target, link);
    expect(() =>
      renderTaskProjection({
        outputRoot: link,
        programs: [program],
        milestones: [approved],
        outcomePackets: []
      })
    ).toThrow(/symlink/);

    const repository = directory();
    mkdirSync(join(repository, ".git"));
    expect(() =>
      renderTaskProjection({
        outputRoot: join(repository, "tasks"),
        programs: [program],
        milestones: [approved],
        outcomePackets: []
      })
    ).toThrow(/source repository/);
  });

  it("matches the auditable golden packet and task projection", () => {
    const root = directory();
    const goldenPacket = OutcomePacketV1Schema.parse(
      JSON.parse(
        readFileSync(
          new URL("../test/fixtures/golden-outcome-packet.json", import.meta.url),
          "utf8"
        )
      ) as unknown
    );
    const goldenProgram: ProgramState = {
      kind: "program",
      programId: goldenPacket.programId,
      name: "Golden walking skeleton",
      status: "active",
      intent: {
        schemaVersion: 1,
        objective: "Produce one verified candidate revision.",
        nonGoals: [],
        tenets: ["Replay", "Evidence", "Bounded authority"],
        riskClass: "normal"
      },
      intentDigest: goldenPacket.intentDigest,
      approvedBy: "golden-operator",
      approvedAt: "2026-08-20T11:00:00.000Z",
      createdAt: "2026-08-20T11:00:00.000Z",
      version: 2
    };
    const goldenMilestone: MilestoneState = {
      kind: "milestone",
      milestoneId: goldenPacket.milestoneId,
      programId: goldenPacket.programId,
      contract: {
        schemaVersion: 1,
        milestoneId: goldenPacket.milestoneId,
        title: "Produce a candidate",
        objective: "Change and verify one tracked file.",
        taskType: "feature",
        priority: "p1",
        tags: ["milestone", "walking-skeleton"],
        workflowId: "70000000-0000-4000-8000-000000000013",
        workflowVersion: 1,
        criteria: [
          {
            criterionId: "candidate-verifies",
            statement: "The candidate passes the registered verifier.",
            verificationStepId: "implement"
          }
        ]
      },
      contractDigest: goldenPacket.milestoneContractDigest,
      workflowDigest: goldenPacket.workflowDigest,
      status: "outcome_ready",
      runId: goldenPacket.runId,
      jobId: "70000000-0000-4000-8000-000000000007",
      baseRevisionId: goldenPacket.baseRevisionId,
      outcomePacketId: goldenPacket.outcomePacketId,
      recommendation: "merge",
      approvedBy: "golden-operator",
      approvedAt: "2026-08-20T11:00:00.000Z",
      startedAt: "2026-08-20T11:30:00.000Z",
      completedAt: goldenPacket.generatedAt,
      version: 3
    };
    const goldenOutcome: OutcomePacketState = {
      kind: "outcome_packet",
      outcomePacketId: goldenPacket.outcomePacketId,
      programId: goldenPacket.programId,
      milestoneId: goldenPacket.milestoneId,
      runId: goldenPacket.runId,
      packet: goldenPacket,
      packetDigest: canonicalDigest(goldenPacket),
      recordedAt: goldenPacket.generatedAt,
      version: 1
    };
    renderTaskProjection({
      outputRoot: root,
      programs: [goldenProgram],
      milestones: [goldenMilestone],
      outcomePackets: [goldenOutcome]
    });
    const expected = readFileSync(
      new URL("../test/fixtures/golden-task-projection.md", import.meta.url),
      "utf8"
    );
    expect(readFileSync(join(root, `${goldenPacket.milestoneId}.md`), "utf8")).toBe(expected);
    expect(goldenPacket.criteriaResults[0]?.evidenceRefs[0]).toEqual(
      goldenPacket.verificationReceipts[0]
    );
  });
});
