import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const imageFile = resolve(".parallelplay-sandbox-image");

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  }).trim();
}

try {
  const context = docker(["context", "show"]);
  const endpoint = JSON.parse(
    docker(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"])
  );
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) {
    throw new Error("remote Docker contexts are forbidden");
  }
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  if (info.OSType !== "linux") throw new Error("Docker must be configured for Linux containers");
  if (!Array.isArray(info.SecurityOptions))
    throw new Error("Docker security features are unavailable");
  if (!info.SecurityOptions.some((value) => String(value).startsWith("name=seccomp"))) {
    throw new Error("Docker seccomp support is required");
  }
  if (!info.SecurityOptions.some((value) => String(value).startsWith("name=cgroupns"))) {
    throw new Error("Docker private cgroup namespaces are required");
  }
  if (!existsSync(imageFile))
    throw new Error("prepared image marker is missing; run pnpm sandbox:prepare");
  const image = readFileSync(imageFile, "utf8").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("prepared image marker is invalid");
  const actual = docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  if (actual !== image) throw new Error("prepared image identity does not match its marker");
  process.stdout.write(`${JSON.stringify({ ok: true, context, endpoint, image })}\n`);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : "Docker sandbox preflight failed"
    })}\n`
  );
  process.exitCode = 1;
}
