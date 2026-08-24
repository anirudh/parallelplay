import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonical,
  readProposal,
  registryEntryFromProposal,
  sortRegistryEntries
} from "./registry-tools.mjs";

const proposalPaths = process.argv.slice(2);
if (proposalPaths.length === 0) {
  throw new Error("Usage: verify-approved.mjs <proposal.json> [...]");
}
const proposals = proposalPaths.map((path) => readProposal(resolve(path)));
for (const proposal of proposals) {
  if (proposal.releaseTag !== "v0.1.0") {
    throw new Error("Approved registry verification applies only to stable v0.1.0 artifacts");
  }
}
const proposedEntries = proposals.flatMap((proposal) => proposal.entries);
const registry = JSON.parse(readFileSync(resolve("compatibility/registry.json"), "utf8"));
if (
  registry.schemaVersion !== 1 ||
  registry.suiteVersion !== "0.1.0" ||
  !Array.isArray(registry.entries) ||
  registry.entries.length !== proposedEntries.length
) {
  throw new Error("Compatibility registry does not exactly cover the stable proposal");
}
const approvedAtByKey = new Map(
  registry.entries.map((entry) => [
    `${entry.extensionId}:${entry.artifactDigest}:${entry.platforms?.join(",")}`,
    entry.approvedAt
  ])
);
const expected = sortRegistryEntries(
  proposedEntries.map((entry) => {
    const key = `${entry.extensionId}:${entry.artifactDigest}:${entry.platforms.join(",")}`;
    const approvedAt = approvedAtByKey.get(key);
    if (typeof approvedAt !== "string" || new Date(approvedAt).toISOString() !== approvedAt) {
      throw new Error(`No valid human approval timestamp for ${key}`);
    }
    return registryEntryFromProposal(entry, approvedAt);
  })
);
const observed = sortRegistryEntries(registry.entries);
if (canonical(expected) !== canonical(observed)) {
  throw new Error("Compatibility registry differs from the exact stable proposal");
}
process.stdout.write(`${JSON.stringify({ ok: true, entries: expected.length })}\n`);
