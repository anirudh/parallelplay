import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  throw new Error("Usage: verify-images-runtime.mjs <provider-image-directory>");
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const expectedImports = new Map([
  ["provider-relay", ["@parallelplay/runtime", "zod"]],
  [
    "provider-runner",
    ["@parallelplay/contracts", "@parallelplay/driver-claude", "@parallelplay/driver-codex", "zod"]
  ]
]);

if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.images) ||
  manifest.images.length !== expectedImports.size
) {
  throw new Error("Provider image manifest is invalid");
}

const verified = [];
for (const image of manifest.images) {
  const imports = expectedImports.get(image.name);
  if (
    !imports ||
    typeof image.archive !== "string" ||
    typeof image.reference !== "string" ||
    !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image.reference)
  ) {
    throw new Error("Provider image manifest contains an unexpected image");
  }
  const archive = join(root, image.archive);
  const readArchiveJson = (path) =>
    JSON.parse(execFileSync("tar", ["-xOf", archive, path], { encoding: "utf8" }));
  const index = readArchiveJson("index.json");
  const descriptor = index.manifests?.find(
    (entry) => entry.digest === `sha256:${image.imageDigest}`
  );
  if (!descriptor) throw new Error("Provider OCI index does not bind the expected image digest");
  const ociManifest = readArchiveJson(`blobs/sha256/${image.imageDigest}`);
  const configDigest = ociManifest.config?.digest;
  const layerDigests = ociManifest.layers?.map((layer) => layer.digest);
  if (
    typeof configDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(configDigest) ||
    !Array.isArray(layerDigests) ||
    layerDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error("Provider OCI manifest has invalid config or layer digests");
  }
  const temporary = mkdtempSync(join(tmpdir(), "parallelplay-provider-smoke-"));
  try {
    const repositoryTag = image.reference.slice(0, image.reference.indexOf("@sha256:"));
    const dockerArchive = join(temporary, "image.tar");
    copyFileSync(archive, dockerArchive);
    writeFileSync(
      join(temporary, "manifest.json"),
      JSON.stringify([
        {
          Config: `blobs/sha256/${configDigest.slice(7)}`,
          RepoTags: [repositoryTag],
          Layers: layerDigests.map((digest) => `blobs/sha256/${digest.slice(7)}`)
        }
      ])
    );
    execFileSync("tar", ["-rf", dockerArchive, "-C", temporary, "manifest.json"], {
      stdio: "ignore"
    });
    execFileSync("docker", ["load", "--input", dockerArchive], { stdio: "ignore" });
    const loadedConfigDigest = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", repositoryTag],
      { encoding: "utf8" }
    ).trim();
    if (
      loadedConfigDigest !== configDigest &&
      loadedConfigDigest !== `sha256:${image.imageDigest}`
    ) {
      throw new Error("Loaded provider image config digest does not match the OCI manifest");
    }
    const expression = `await Promise.all(${JSON.stringify(imports)}.map((name) => import(name)));`;
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "32",
        "--memory",
        "268435456",
        "--cpus",
        "1",
        "--user",
        "65534:65534",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=8388608",
        "--entrypoint",
        "node",
        repositoryTag,
        "--input-type=module",
        "--eval",
        expression
      ],
      { stdio: "ignore" }
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  verified.push(image.name);
}

process.stdout.write(`${JSON.stringify({ ok: true, images: verified.sort() })}\n`);
