import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function exactDigest(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${field} must be an exact SHA-256 digest`);
  }
  return value;
}

export function readProposal(path) {
  const proposal = JSON.parse(readFileSync(path, "utf8"));
  if (
    proposal.schemaVersion !== 1 ||
    proposal.suiteVersion !== "0.1.0" ||
    !/^v0\.1\.0(?:-rc\.[1-9][0-9]*)?$/.test(proposal.releaseTag) ||
    !/^[a-f0-9]{40,64}$/.test(proposal.sourceCommit) ||
    !Array.isArray(proposal.entries) ||
    proposal.entries.length !== 9
  ) {
    throw new Error("Compatibility proposal has an invalid release identity or entry count");
  }
  exactDigest(proposal.attestationBundleDigest, "attestationBundleDigest");
  const seen = new Set();
  for (const entry of proposal.entries) {
    const key = `${entry.extensionId}:${entry.artifactDigest}:${entry.platforms?.join(",")}`;
    if (seen.has(key)) throw new Error(`Duplicate compatibility proposal entry: ${key}`);
    seen.add(key);
    if (
      typeof entry.extensionId !== "string" ||
      !/^[a-z][a-z0-9._-]*$/.test(entry.extensionId) ||
      entry.extensionVersion !== proposal.releaseTag.slice(1) ||
      entry.sourceCommit !== proposal.sourceCommit ||
      !Array.isArray(entry.platforms) ||
      entry.platforms.length < 1 ||
      entry.platforms.length > 2 ||
      entry.platforms.some((platform) => !/^(?:linux|macos)-(?:x64|arm64)$/.test(platform)) ||
      new Set(entry.platforms).size !== entry.platforms.length
    ) {
      throw new Error(`Invalid compatibility proposal entry: ${entry.extensionId ?? "unknown"}`);
    }
    for (const field of [
      "artifactDigest",
      "conformanceReportDigest",
      "conformanceEvidenceBundleDigest",
      "sbomDigest",
      "provenanceDigest",
      "manifestDigest"
    ]) {
      exactDigest(entry[field], `${entry.extensionId}.${field}`);
    }
    if (entry.provenanceDigest !== proposal.attestationBundleDigest) {
      throw new Error(`${entry.extensionId} is not bound to the proposal attestation bundle`);
    }
  }
  return proposal;
}

export function registryEntryFromProposal(entry, approvedAt) {
  return {
    extensionId: entry.extensionId,
    extensionVersion: entry.extensionVersion,
    artifactDigest: entry.artifactDigest,
    sourceCommit: entry.sourceCommit,
    conformanceReportDigest: entry.conformanceReportDigest,
    sbomDigest: entry.sbomDigest,
    provenanceDigest: entry.provenanceDigest,
    platforms: [...entry.platforms].sort(),
    approvedAt
  };
}

export function registryDigest(registry) {
  return digest(registry);
}

export function sortRegistryEntries(entries) {
  return [...entries].sort((left, right) => {
    const byId = left.extensionId.localeCompare(right.extensionId);
    if (byId !== 0) return byId;
    const byArtifact = left.artifactDigest.localeCompare(right.artifactDigest);
    if (byArtifact !== 0) return byArtifact;
    return left.platforms.join(",").localeCompare(right.platforms.join(","));
  });
}
