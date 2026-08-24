import { createHash } from "node:crypto";
import {
  WorkflowExtensionRequestV1Schema,
  ExtensionManifestV1Schema,
  isAutomaticActionAllowed,
  type ExtensionManifestV1,
  type PolicyExtensionRequestV1,
  type PolicyExtensionResultV1,
  type PolicyExtensionV1,
  type WorkflowExtensionResultV1,
  type WorkflowExtensionV1
} from "@parallelplay/contracts";

function digest(value: string): string {
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

export class GenericSoftwareWorkflow implements WorkflowExtensionV1 {
  readonly manifest: ExtensionManifestV1;

  constructor(manifest: ExtensionManifestV1) {
    this.manifest = parseManifest(
      manifest,
      "generic-software",
      "workflow",
      "workflow-extension-v1"
    );
  }

  async compile(
    request: Parameters<WorkflowExtensionV1["compile"]>[0]
  ): Promise<WorkflowExtensionResultV1> {
    const parsed = WorkflowExtensionRequestV1Schema.parse(request);
    const ids = new Set(parsed.milestones.map((milestone) => milestone.id));
    const errors: { code: string; message: string }[] = [];
    for (const milestone of parsed.milestones) {
      for (const dependency of milestone.dependencies) {
        if (!ids.has(dependency)) {
          errors.push({
            code: "unknown-dependency",
            message: `${milestone.id} depends on unknown milestone ${dependency}`
          });
        }
        if (dependency === milestone.id) {
          errors.push({ code: "self-dependency", message: `${milestone.id} depends on itself` });
        }
      }
    }

    const incoming = new Map(
      parsed.milestones.map((milestone) => [milestone.id, milestone.dependencies.length])
    );
    const ready = parsed.milestones
      .filter((milestone) => milestone.dependencies.length === 0)
      .map((milestone) => milestone.id)
      .sort();
    const ordered: string[] = [];
    while (ready.length > 0) {
      const current = ready.shift();
      if (!current) throw new Error("Ready workflow node disappeared");
      ordered.push(current);
      for (const milestone of parsed.milestones) {
        if (!milestone.dependencies.includes(current)) continue;
        const next = (incoming.get(milestone.id) ?? 0) - 1;
        incoming.set(milestone.id, next);
        if (next === 0) ready.push(milestone.id);
      }
      ready.sort();
    }
    if (ordered.length !== parsed.milestones.length) {
      errors.push({ code: "cycle", message: "Workflow contains a dependency cycle" });
    }

    const normalized = {
      profileId: parsed.profileId,
      intentDigest: parsed.intentDigest,
      milestoneOrder: ordered,
      milestones: [...parsed.milestones].sort((left, right) => left.id.localeCompare(right.id))
    };
    return Promise.resolve({
      schemaVersion: 1,
      accepted: errors.length === 0,
      compilerDigest: digest("generic-software-compiler-v1"),
      workflowDigest: errors.length === 0 ? digest(canonical(normalized)) : null,
      normalized: errors.length === 0 ? normalized : null,
      errors
    });
  }
}

export class GenericSafetyPolicy implements PolicyExtensionV1 {
  readonly manifest: ExtensionManifestV1;

  constructor(manifest: ExtensionManifestV1) {
    this.manifest = parseManifest(
      manifest,
      "generic-safety-ceiling",
      "policy",
      "policy-extension-v1"
    );
  }

  async decide(request: PolicyExtensionRequestV1): Promise<PolicyExtensionResultV1> {
    const allowed =
      isAutomaticActionAllowed(request.proposedAction) &&
      request.risk === "low" &&
      !request.irreversible;
    return Promise.resolve({
      schemaVersion: 1,
      decision: allowed ? "allow_within_global_ceiling" : "deny",
      policyDigest: request.policyDigest,
      evidenceDigest: request.evidenceDigest,
      proposedAction: request.proposedAction,
      rationale: allowed
        ? "The action is low-risk, reversible, and inside the global allowlist"
        : "The action is outside the immutable generic safety ceiling"
    });
  }
}

export const GENERIC_WALKING_SKELETON = {
  schemaVersion: 1 as const,
  profileId: "generic-software",
  milestones: [
    {
      id: "specify",
      title: "Specify the change",
      dependencies: [],
      criteria: ["The requested behavior has an executable acceptance test"]
    },
    {
      id: "implement",
      title: "Implement the change",
      dependencies: ["specify"],
      criteria: ["The acceptance test passes", "The existing verification command passes"]
    },
    {
      id: "review",
      title: "Review retained evidence",
      dependencies: ["implement"],
      criteria: ["The candidate and receipts are digest-bound and replayable"]
    }
  ]
};

function parseManifest(
  manifest: ExtensionManifestV1,
  id: string,
  kind: ExtensionManifestV1["kind"],
  contract: ExtensionManifestV1["contract"]["name"]
): ExtensionManifestV1 {
  const parsed = ExtensionManifestV1Schema.parse(manifest);
  if (parsed.id !== id || parsed.kind !== kind || parsed.contract.name !== contract) {
    throw new Error(`${id} requires a matching ${contract} manifest`);
  }
  return parsed;
}
