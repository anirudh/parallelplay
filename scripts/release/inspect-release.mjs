import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { buildRelease } from "./build-release.mjs";
import { readTarGz } from "./archive.mjs";

const forbiddenNames = [["staff", "plane"].join(""), ["hob", "bes"].join("")];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function inspectRelease(directory) {
  const root = resolve(directory);
  const failures = [];
  const buildManifest = JSON.parse(readFileSync(join(root, "build-manifest.json"), "utf8"));
  const licenseInventory = JSON.parse(readFileSync(join(root, "license-inventory.json"), "utf8"));
  if (!Array.isArray(licenseInventory.packages) || licenseInventory.packages.length === 0) {
    failures.push("license-inventory.json: dependency inventory is empty");
  } else if (
    licenseInventory.packages.some(
      (entry) =>
        typeof entry.license !== "string" ||
        /^(?:UNKNOWN|UNLICENSED|PROPRIETARY)$/i.test(entry.license)
    )
  ) {
    failures.push("license-inventory.json: unknown or forbidden license");
  }
  for (const artifact of buildManifest.artifacts ?? []) {
    const sbomPath = join(root, `${artifact.name}.spdx.json`);
    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    const described = (sbom.packages ?? []).find((entry) => entry.SPDXID === "SPDXRef-Artifact");
    const checksum = described?.checksums?.find(
      (entry) => entry.algorithm === "SHA256"
    )?.checksumValue;
    if (sbom.spdxVersion !== "SPDX-2.3" || checksum !== artifact.sha256) {
      failures.push(`${artifact.name}: SBOM is not bound to the artifact checksum`);
    }
  }
  const checksumLines = readFileSync(join(root, "SHA256SUMS"), "utf8").trim().split("\n");
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      failures.push(`Malformed checksum line: ${line}`);
      continue;
    }
    const [, expected, name] = match;
    if (sha256(readFileSync(join(root, name))) !== expected)
      failures.push(`${name}: checksum mismatch`);
  }
  const archives = readdirSync(root)
    .filter((name) => /\.(?:tgz|tar\.gz)$/.test(name))
    .sort();
  for (const name of archives) {
    if (name.includes("sdk-") || name.endsWith("source.tar.gz")) continue;
    const entries = readTarGz(readFileSync(join(root, name)));
    if (entries.length === 0) failures.push(`${name}: archive is empty`);
    for (const entry of entries) {
      const path = entry.path.toLowerCase();
      if (path.startsWith("/") || path.split("/").includes(".."))
        failures.push(`${name}: unsafe path ${entry.path}`);
      if (
        /(^|\/)(?:test|tests|__tests__)(\/|$)/i.test(path) ||
        /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
      ) {
        failures.push(`${name}: test file entered archive: ${entry.path}`);
      }
      if (entry.type !== "file" || entry.data.includes(0)) continue;
      const text = entry.data.toString("utf8");
      if (text.includes("workspace:*"))
        failures.push(`${name}: workspace dependency entered ${entry.path}`);
      if (/\/Users\/[A-Za-z0-9._-]+/.test(text))
        failures.push(`${name}: absolute user path entered ${entry.path}`);
      const lower = text.toLowerCase();
      for (const forbidden of forbiddenNames) {
        if (lower.includes(forbidden))
          failures.push(`${name}: excluded predecessor identity entered ${entry.path}`);
      }
    }
    if (
      name.includes("cli-") &&
      !entries.some((entry) => entry.path.endsWith("/bin/parallelplay"))
    ) {
      failures.push(`${name}: CLI launcher is missing`);
    }
  }
  if (failures.length) throw new Error([...new Set(failures)].sort().join("\n"));
  return { ok: true, archives: archives.length, checksums: checksumLines.length };
}

if (process.argv[1] && basename(process.argv[1]) === "inspect-release.mjs") {
  const output = process.argv[2] ?? ".parallelplay-release/inspection";
  buildRelease(output);
  process.stdout.write(`${JSON.stringify(inspectRelease(output))}\n`);
}
