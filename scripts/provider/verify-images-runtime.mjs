import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  execFileSync("docker", ["load", "--input", join(root, image.archive)], { stdio: "ignore" });
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
      image.reference,
      "--input-type=module",
      "--eval",
      expression
    ],
    { stdio: "ignore" }
  );
  verified.push(image.name);
}

process.stdout.write(`${JSON.stringify({ ok: true, images: verified.sort() })}\n`);
