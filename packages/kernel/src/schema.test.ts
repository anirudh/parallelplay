import { describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { CommandSchema, WorkflowDefinitionSchema, WorkflowDefinitionV2Schema } from "./schema.js";

const workflowId = "00000000-0000-4000-8000-000000000002";

function workflow(steps: unknown[]) {
  return { workflowId, version: 1, name: "Test workflow", steps };
}

const execution = {
  protocolVersion: 1,
  image: `parallelplay-fixture@sha256:${"0".repeat(64)}`,
  argv: ["/bin/true"],
  workingDirectory: "/workspace"
};
const capabilities = {
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
};

function workflowV2(steps: unknown[]) {
  return { ...workflow(steps), schemaVersion: 2 };
}

describe("WorkflowDefinitionSchema", () => {
  it("accepts an acyclic provider-neutral workflow", () => {
    expect(
      WorkflowDefinitionSchema.parse(
        workflow([
          { id: "plan", capability: "planning", dependsOn: [] },
          { id: "build", capability: "implementation", dependsOn: ["plan"] }
        ])
      )
    ).toMatchObject({ workflowId, version: 1 });
  });

  it("requires execution, capability, and verifier contracts for new registrations", () => {
    expect(
      WorkflowDefinitionV2Schema.parse(
        workflowV2([
          {
            id: "execute",
            capability: "implementation",
            dependsOn: [],
            execution,
            capabilities,
            verification: {
              mode: "verify",
              argv: ["./verify.sh"],
              cwd: ".",
              timeoutMs: 1_000,
              environment: {},
              toolProbes: []
            }
          }
        ])
      )
    ).toMatchObject({ schemaVersion: 2 });
  });

  it("keeps legacy definitions replayable but rejects them for new registrations", () => {
    const legacy = workflow([{ id: "plan", capability: "planning", dependsOn: [] }]);
    expect(WorkflowDefinitionSchema.parse(legacy)).toEqual(legacy);
    expect(() =>
      CommandSchema.parse({
        type: "workflow.register",
        idempotencyKey: "legacy-registration",
        actor: { kind: "operator", id: "schema-test" },
        payload: legacy
      })
    ).toThrow();
  });

  it("rejects floating images and nonempty network, secret, or Git grants", () => {
    const step = {
      id: "execute",
      capability: "implementation",
      dependsOn: [],
      execution,
      capabilities,
      verification: {
        mode: "verify",
        argv: ["./verify.sh"],
        cwd: ".",
        timeoutMs: 1_000,
        environment: {},
        toolProbes: []
      }
    };
    expect(() =>
      WorkflowDefinitionV2Schema.parse(
        workflowV2([{ ...step, execution: { ...execution, image: "fixture:latest" } }])
      )
    ).toThrow();
    expect(() =>
      WorkflowDefinitionV2Schema.parse(
        workflowV2([{ ...step, capabilities: { ...capabilities, network: ["public"] } }])
      )
    ).toThrow();
  });

  it.each([
    [
      "duplicate steps",
      [
        { id: "plan", capability: "planning", dependsOn: [] },
        { id: "plan", capability: "review", dependsOn: [] }
      ]
    ],
    ["unknown dependencies", [{ id: "build", capability: "implementation", dependsOn: ["plan"] }]],
    [
      "cycles",
      [
        { id: "plan", capability: "planning", dependsOn: ["build"] },
        { id: "build", capability: "implementation", dependsOn: ["plan"] }
      ]
    ],
    ["self dependencies", [{ id: "plan", capability: "planning", dependsOn: ["plan"] }]]
  ])("rejects %s", (_label, steps) => {
    expect(() => WorkflowDefinitionSchema.parse(workflow(steps))).toThrow();
  });

  it("rejects unknown properties", () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...workflow([{ id: "plan", capability: "planning", dependsOn: [] }]),
        provider: "codex"
      })
    ).toThrow();
  });

  it("hashes validated JSON independently of object key order", () => {
    const left = { a: 1, nested: { z: true, b: "value" } };
    const right = { nested: { b: "value", z: true }, a: 1 };
    expect(canonicalDigest(left)).toBe(canonicalDigest(right));
  });
});
