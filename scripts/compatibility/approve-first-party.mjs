import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonical,
  readProposal,
  registryEntryFromProposal,
  sortRegistryEntries
} from "./registry-tools.mjs";

const approvedAt = process.argv[2];
const proposalPaths = process.argv.slice(3);
if (
  proposalPaths.length === 0 ||
  !approvedAt ||
  new Date(approvedAt).toISOString() !== approvedAt
) {
  throw new Error(
    "Usage: approve-first-party.mjs <approved-at ISO timestamp> <proposal.json> [...]"
  );
}
const proposals = proposalPaths.map((path) => readProposal(resolve(path)));
for (const proposal of proposals) {
  if (proposal.releaseTag !== "v0.1.0") {
    throw new Error("Only stable v0.1.0 artifacts can enter the compatibility registry");
  }
}
const registry = {
  schemaVersion: 1,
  suiteVersion: "0.1.0",
  entries: sortRegistryEntries(
    proposals.flatMap((proposal) =>
      proposal.entries.map((entry) => registryEntryFromProposal(entry, approvedAt))
    )
  )
};
const path = resolve("compatibility/registry.json");
writeFileSync(path, `${canonical(registry)}\n`, { mode: 0o644 });
process.stdout.write(
  `${JSON.stringify({ ok: true, registry: path, entries: registry.entries.length })}\n`
);
