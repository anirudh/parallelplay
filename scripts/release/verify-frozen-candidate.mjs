import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readProposal } from "../compatibility/registry-tools.mjs";

const releaseDirectory = resolve(process.argv[2] ?? "release-assets");
const proposalPaths = process.argv.slice(3).map(resolve);
if (proposalPaths.length !== 2) {
  throw new Error("Frozen stable candidate requires Linux x64 and Linux arm64 proposals");
}
const proposals = proposalPaths.map(readProposal);
if (proposals.some((proposal) => proposal.releaseTag !== "v0.1.0")) {
  throw new Error("Frozen candidate is not for v0.1.0");
}
const sourceCommits = new Set(proposals.map((proposal) => proposal.sourceCommit));
if (sourceCommits.size !== 1) throw new Error("Stable proposals do not share one source commit");
const sourceCommit = [...sourceCommits][0];
execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, "HEAD"]);
const allowedChanges = new Set([
  "CHANGELOG.md",
  "compatibility/registry.json",
  "docs/SLICE10_PILOT.md",
  "docs/SLICE10_READINESS.md"
]);
const changed = execFileSync("git", ["diff", "--name-only", `${sourceCommit}..HEAD`], {
  encoding: "utf8"
})
  .trim()
  .split("\n")
  .filter(Boolean);
const forbidden = changed.filter((path) => !allowedChanges.has(path));
if (forbidden.length) {
  throw new Error(`Code changed after compatibility evidence: ${forbidden.join(", ")}`);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const providerManifests = readdirSync(releaseDirectory)
  .filter((name) => /^provider-images-0\.1\.0-linux-(?:x64|arm64)\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(releaseDirectory, name), "utf8")));
if (providerManifests.length !== 2) throw new Error("Frozen candidate lacks both provider images");

for (const proposal of proposals) {
  for (const entry of proposal.entries) {
    if (entry.artifactReference.startsWith("https://github.com/")) {
      const name = basename(new URL(entry.artifactReference).pathname);
      if (sha256(join(releaseDirectory, name)) !== entry.artifactDigest) {
        throw new Error(`${entry.extensionId} package changed after compatibility approval`);
      }
      continue;
    }
    const image = providerManifests
      .flatMap((manifest) => manifest.images)
      .find(
        (candidate) =>
          candidate.reference === entry.artifactReference &&
          candidate.imageDigest === entry.artifactDigest
      );
    if (!image) throw new Error(`${entry.extensionId} provider image is not frozen`);
  }
}
process.stdout.write(
  `${JSON.stringify({ ok: true, sourceCommit, changed, proposals: proposals.length })}\n`
);
