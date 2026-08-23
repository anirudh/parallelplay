import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "release-assets");
const version = "0.1.0";
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? "1767225600");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
};

const initialFiles = readdirSync(directory)
  .filter((name) => !["SHA256SUMS", "build-manifest.json"].includes(name))
  .sort();
const cliPlatforms = initialFiles
  .map((name) => /^parallelplay-cli-0\.1\.0-(.+)\.tar\.gz$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();
if (JSON.stringify(cliPlatforms) !== JSON.stringify(["linux-arm64", "linux-x64", "macos-arm64"])) {
  throw new Error(`Expected all CLI platforms, observed ${cliPlatforms.join(", ")}`);
}

const artifacts = initialFiles
  .filter((name) => /\.(?:tgz|tar\.gz)$/.test(name))
  .map((name) => {
    const bytes = readFileSync(join(directory, name));
    return { name, sha256: sha256(bytes), size: bytes.length };
  });
const manifest = {
  schemaVersion: 1,
  version,
  sourceDateEpoch: epoch,
  node: "22.17.1+",
  pnpm: "11.19.0",
  platforms: cliPlatforms,
  artifacts
};
writeFileSync(join(directory, "build-manifest.json"), `${canonical(manifest)}\n`);

const files = readdirSync(directory)
  .filter((name) => name !== "SHA256SUMS")
  .sort();
writeFileSync(
  join(directory, "SHA256SUMS"),
  `${files.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${basename(name)}`).join("\n")}\n`
);
process.stdout.write(
  `${JSON.stringify({ ok: true, platforms: cliPlatforms, files: files.length + 1 })}\n`
);
