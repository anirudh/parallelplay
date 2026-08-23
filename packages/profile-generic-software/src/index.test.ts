import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenericSafetyPolicy, GenericSoftwareWorkflow } from "./index.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("generic software profile", () => {
  it("compiles a deterministic DAG and rejects cycles", async () => {
    const workflow = new GenericSoftwareWorkflow();
    const base = {
      schemaVersion: 1 as const,
      profileId: "generic-software",
      intentDigest: digest("intent")
    };
    const valid = await workflow.compile({
      ...base,
      milestones: [
        { id: "a", title: "A", dependencies: [], criteria: ["A passes"] },
        { id: "b", title: "B", dependencies: ["a"], criteria: ["B passes"] }
      ]
    });
    expect(valid.accepted).toBe(true);
    expect(valid.workflowDigest).toMatch(/^[a-f0-9]{64}$/);

    const cycle = await workflow.compile({
      ...base,
      milestones: [
        { id: "a", title: "A", dependencies: ["b"], criteria: ["A passes"] },
        { id: "b", title: "B", dependencies: ["a"], criteria: ["B passes"] }
      ]
    });
    expect(cycle.accepted).toBe(false);
    expect(cycle.errors.some((entry) => entry.code === "cycle")).toBe(true);
  });

  it("never permits merge or high-risk automation", async () => {
    const policy = new GenericSafetyPolicy();
    const base = {
      schemaVersion: 1 as const,
      policyDigest: digest("policy"),
      evidenceDigest: digest("evidence"),
      irreversible: false,
      externalEffect: true
    };
    expect(
      (await policy.decide({ ...base, proposedAction: "github.comment.create", risk: "low" }))
        .decision
    ).toBe("allow_within_global_ceiling");
    expect((await policy.decide({ ...base, proposedAction: "merge", risk: "low" })).decision).toBe(
      "deny"
    );
    expect(
      (await policy.decide({ ...base, proposedAction: "github.comment.create", risk: "high" }))
        .decision
    ).toBe("deny");
  });
});
