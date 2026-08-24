import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const output = resolve(process.argv[2] ?? ".parallelplay-release/provider-images");
mkdirSync(output, { recursive: true, mode: 0o755 });
const docker = process.env.DOCKER ?? "docker";
const version = process.env.PARALLELPLAY_RELEASE_VERSION ?? "0.1.0";
const epoch = process.env.SOURCE_DATE_EPOCH ?? "1767225600";
const platform =
  process.env.PARALLELPLAY_PROVIDER_PLATFORM ??
  (process.arch === "arm64" ? "linux-arm64" : "linux-x64");
if (!/^0\.1\.0(?:-rc\.[1-9][0-9]*)?$/.test(version)) throw new Error("Invalid release version");
if (!["linux-x64", "linux-arm64"].includes(platform)) {
  throw new Error("PARALLELPLAY_PROVIDER_PLATFORM must be linux-x64 or linux-arm64");
}
const dockerPlatform = platform === "linux-arm64" ? "linux/arm64" : "linux/amd64";

function build(name, targetPackage) {
  const tag = `parallelplay-${name}:${version}`;
  const archive = join(output, `${name}.oci.tar`);
  execFileSync(
    docker,
    [
      "buildx",
      "build",
      "--file",
      "containers/provider.Dockerfile",
      "--platform",
      dockerPlatform,
      "--build-arg",
      `TARGET_PACKAGE=${targetPackage}`,
      "--build-arg",
      `SOURCE_DATE_EPOCH=${epoch}`,
      "--provenance=false",
      "--sbom=false",
      "--tag",
      tag,
      "--output",
      `type=oci,dest=${archive},tar=true,rewrite-timestamp=true`,
      "."
    ],
    { stdio: "inherit", env: { ...process.env, SOURCE_DATE_EPOCH: epoch } }
  );
  const index = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "index.json"], { encoding: "utf8" })
  );
  const imageDigest = index.manifests?.[0]?.digest;
  if (typeof imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(imageDigest)) {
    throw new Error(`${name} OCI archive has no immutable manifest digest`);
  }
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  return {
    name,
    targetPackage,
    reference: `${tag}@${imageDigest}`,
    imageDigest: imageDigest.slice(7),
    archive: basename(archive),
    archiveDigest: digest
  };
}

const images = [
  build("provider-relay", "@parallelplay/provider-relay"),
  build("provider-runner", "@parallelplay/provider-runner")
];
writeFileSync(
  join(output, "manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, version, platform, images }, null, 2)}\n`,
  { mode: 0o644 }
);
process.stdout.write(`${JSON.stringify({ ok: true, images })}\n`);
