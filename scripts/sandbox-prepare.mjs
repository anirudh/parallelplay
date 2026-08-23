import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const base = "redis@sha256:e7723ff73d963f5cc6d9c4643ea3d989527a402a319239054e9472a7fb9219a2";
const target = resolve(".parallelplay-sandbox-image");
const temporary = mkdtempSync(join(tmpdir(), "parallelplay-sandbox-prepare-"));
const iid = join(temporary, "image-id");

function docker(args, stdio = "inherit") {
  execFileSync("docker", args, {
    stdio,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
}

try {
  execFileSync(process.execPath, [resolve("scripts/sandbox-check.mjs")], { stdio: "ignore" });
} catch {
  // The first preparation is expected to run before the image marker exists.
}

try {
  try {
    execFileSync("docker", ["image", "inspect", base], { stdio: "ignore" });
  } catch {
    docker(["pull", base]);
  }
  const container = `parallelplay-fixture-prepare-${randomUUID()}`;
  let image;
  try {
    docker(["create", "--name", container, "--pull", "never", base, "/bin/true"], "ignore");
    docker(["cp", `${resolve("sandbox/fixture")}/.`, `${container}:/fixture`], "ignore");
    image = execFileSync(
      "docker",
      ["commit", "--change", "ENTRYPOINT []", "--change", "CMD []", container],
      { encoding: "utf8" }
    ).trim();
  } finally {
    execFileSync("docker", ["rm", "--force", container], { stdio: "ignore" });
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Docker returned an invalid image ID");
  writeFileSync(iid, `${image}\n`, { mode: 0o600 });
  renameSync(iid, target);
  process.stdout.write(`${JSON.stringify({ ok: true, base, image })}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
