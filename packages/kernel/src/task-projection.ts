import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { canonicalDigest } from "./canonical.js";
import type { MilestoneState, OutcomePacketState, ProgramState } from "./schema.js";

const OWNERSHIP_MANIFEST = ".parallelplay-task-projection.json";
const TaskFileSchema = z.strictObject({
  milestoneId: z.uuid(),
  path: z.string().regex(/^[0-9a-f-]{36}\.md$/i),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
});
const OwnershipManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(TaskFileSchema),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
type OwnershipManifest = z.infer<typeof OwnershipManifestSchema>;

export interface TaskProjectionInput {
  outputRoot: string;
  programs: ProgramState[];
  milestones: MilestoneState[];
  outcomePackets: OutcomePacketState[];
}

export interface TaskProjectionResult {
  outputRoot: string;
  ownershipManifest: string;
  files: { milestoneId: string; path: string; digest: string }[];
  removed: string[];
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function statusFor(
  milestone: MilestoneState,
  outcome: OutcomePacketState | undefined
): "todo" | "building" | "needs-ship" | "blocked" {
  if (outcome?.packet.recommendation === "merge") return "needs-ship";
  if (outcome) return "blocked";
  return milestone.status === "running" ? "building" : "todo";
}

function renderMilestone(
  program: ProgramState,
  milestone: MilestoneState,
  outcome: OutcomePacketState | undefined
): string {
  const updated = milestone.completedAt ?? milestone.startedAt ?? milestone.approvedAt;
  const status = statusFor(milestone, outcome);
  const criteria = outcome
    ? outcome.packet.criteriaResults
    : milestone.contract.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        statement: criterion.statement,
        result: "unverified" as const,
        evidenceRefs: []
      }));
  const lines = [
    "---",
    `id: ${yaml(milestone.milestoneId)}`,
    `title: ${yaml(milestone.contract.title)}`,
    `type: ${milestone.contract.taskType}`,
    `status: ${status}`,
    `priority: ${milestone.contract.priority}`,
    `created: ${yaml(milestone.approvedAt)}`,
    `updated: ${yaml(updated)}`,
    "tags:",
    ...milestone.contract.tags.map((tag) => `  - ${yaml(tag)}`),
    "parallelplay:",
    `  program_id: ${yaml(program.programId)}`,
    `  milestone_id: ${yaml(milestone.milestoneId)}`,
    `  run_id: ${milestone.runId ? yaml(milestone.runId) : "null"}`,
    `  outcome_packet_id: ${outcome ? yaml(outcome.outcomePacketId) : "null"}`,
    `  intent_digest: ${program.intentDigest ? yaml(program.intentDigest) : "null"}`,
    `  milestone_contract_digest: ${yaml(milestone.contractDigest)}`,
    `  workflow_digest: ${yaml(milestone.workflowDigest)}`,
    "---",
    "",
    `# ${milestone.contract.title}`,
    "",
    "## Objective",
    "",
    milestone.contract.objective,
    "",
    "## Criteria",
    "",
    ...criteria.map((criterion) => {
      const checked = criterion.result === "pass" ? "x" : " ";
      return `- [${checked}] ${criterion.statement} (${criterion.criterionId}: ${criterion.result})`;
    }),
    "",
    "## Outcome",
    "",
    ...(outcome
      ? [
          `- Recommendation: ${outcome.packet.recommendation}`,
          `- Summary: ${outcome.packet.summary}`,
          `- Terminal reason: ${outcome.packet.terminalReason}`,
          `- Candidate revision: ${outcome.packet.candidateRevisionId ?? "none"}`
        ]
      : [`- Status: ${milestone.status}`, "- Recommendation: pending"]),
    "",
    "## Attempts",
    "",
    ...(outcome && outcome.packet.attemptHistory.length > 0
      ? [
          "| Ordinal | Attempt | Status | Usage | Terminal reason |",
          "| ---: | --- | --- | --- | --- |",
          ...outcome.packet.attemptHistory.map(
            (attempt) =>
              `| ${String(attempt.ordinal)} | ${attempt.attemptId} | ${attempt.status} | ${attempt.usage ? `${String(attempt.usage.cpuMillis)} ms CPU, ${String(attempt.usage.memoryPeakBytes)} bytes peak` : "not recorded"} | ${attempt.terminationReason ?? "none"} |`
          )
        ]
      : ["No attempts recorded."]),
    "",
    "## Evidence",
    "",
    ...(outcome
      ? [
          ...outcome.packet.driverReceipts.map(
            (reference) => `- Driver receipt ${reference.id}: \`${reference.digest}\``
          ),
          ...outcome.packet.verificationReceipts.map(
            (reference) => `- Verification receipt ${reference.id}: \`${reference.digest}\``
          ),
          ...outcome.packet.artifactManifests.map(
            (reference) => `- Artifact manifest ${reference.id}: \`${reference.digest}\``
          ),
          ...(outcome.packet.driverReceipts.length === 0 &&
          outcome.packet.verificationReceipts.length === 0 &&
          outcome.packet.artifactManifests.length === 0
            ? ["No terminal evidence receipts were recorded."]
            : [])
        ]
      : ["Evidence will appear after the milestone reaches a terminal outcome."]),
    ""
  ];
  return lines.join("\n");
}

function assertSafeRoot(input: string): string {
  if (!input.trim()) throw new Error("Task projection output root is required");
  if (!isAbsolute(input)) throw new Error("Task projection output root must be absolute");
  const rawParts = input.split(sep);
  if (rawParts.includes(".") || rawParts.includes("..")) {
    throw new Error("Task projection output root cannot contain traversal segments");
  }
  const resolved = resolve(input);
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new Error("Task projection output root is a symlink");
  }
  let existing = resolved;
  const missingParts: string[] = [];
  while (!existsSync(existing)) {
    missingParts.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) throw new Error("Task projection output root has no existing parent");
    existing = parent;
  }
  const root = join(realpathSync(existing), ...missingParts);
  const parsed = parse(root);
  let current = parsed.root;
  for (const part of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Task projection path crosses a symlink: ${current}`);
    }
    if (existsSync(join(current, ".git"))) {
      throw new Error("Task projection output root cannot be inside a source repository");
    }
  }
  if (existsSync(root) && !lstatSync(root).isDirectory()) {
    throw new Error("Task projection output root must be a directory");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error("Task projection output root is a symlink");
  return root;
}

function digestFile(path: string): string {
  return canonicalDigest({ schemaVersion: 1, content: readFileSync(path, "utf8") });
}

function atomicWrite(path: string, content: string): void {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
    throw new Error(`Task projection target is not a plain file: ${path}`);
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary);
  }
}

function ownershipDigest(files: OwnershipManifest["files"]): string {
  return canonicalDigest({ schemaVersion: 1, files });
}

function readOwnershipManifest(root: string): OwnershipManifest | null {
  const path = join(root, OWNERSHIP_MANIFEST);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error("Task projection ownership manifest is not a plain file");
  }
  if (lstatSync(path).size > 1_048_576) {
    throw new Error("Task projection ownership manifest exceeds 1 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Task projection ownership manifest is not valid JSON");
  }
  const manifest = OwnershipManifestSchema.parse(value);
  if (ownershipDigest(manifest.files) !== manifest.manifestDigest) {
    throw new Error("Task projection ownership manifest digest does not match");
  }
  return manifest;
}

export function renderTaskProjection(input: TaskProjectionInput): TaskProjectionResult {
  const root = assertSafeRoot(input.outputRoot);
  const previous = readOwnershipManifest(root);
  const previousByPath = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
  for (const file of previous?.files ?? []) {
    const path = join(root, file.path);
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Owned task projection file is missing or unsafe: ${file.path}`);
    }
    if (digestFile(path) !== file.digest) {
      throw new Error(`Owned task projection file was modified: ${file.path}`);
    }
  }

  const programs = new Map(input.programs.map((program) => [program.programId, program]));
  const outcomes = new Map(input.outcomePackets.map((outcome) => [outcome.milestoneId, outcome]));
  const rendered = [...input.milestones]
    .sort((left, right) => left.milestoneId.localeCompare(right.milestoneId))
    .map((milestone) => {
      const program = programs.get(milestone.programId);
      if (!program) throw new Error(`Program is missing for milestone ${milestone.milestoneId}`);
      const relativePath = `${milestone.milestoneId}.md`;
      const path = join(root, relativePath);
      if (existsSync(path) && !previousByPath.has(relativePath)) {
        throw new Error(`Task projection refuses to overwrite an unowned file: ${relativePath}`);
      }
      const content = renderMilestone(program, milestone, outcomes.get(milestone.milestoneId));
      return {
        milestoneId: milestone.milestoneId,
        path: relativePath,
        absolutePath: path,
        content,
        digest: canonicalDigest({ schemaVersion: 1, content })
      };
    });

  const nextPaths = new Set(rendered.map((file) => file.path));
  const stale = (previous?.files ?? []).filter((file) => !nextPaths.has(file.path));
  for (const file of rendered) atomicWrite(file.absolutePath, file.content);
  for (const file of stale) rmSync(join(root, file.path));

  const files = rendered.map(({ milestoneId, path, digest }) => ({ milestoneId, path, digest }));
  const manifest: OwnershipManifest = {
    schemaVersion: 1,
    files,
    manifestDigest: ownershipDigest(files)
  };
  const manifestPath = join(root, OWNERSHIP_MANIFEST);
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    outputRoot: root,
    ownershipManifest: manifestPath,
    files,
    removed: stale.map((file) => file.path)
  };
}
