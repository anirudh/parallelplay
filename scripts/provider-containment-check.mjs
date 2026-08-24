import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const docker = process.env.DOCKER ?? "docker";
const image =
  "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854";
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const internal = `pp-proof-internal-${suffix}`;
const egress = `pp-proof-egress-${suffix}`;
const relayName = `pp-proof-relay-${suffix}`;
const fixture = resolve("sandbox/provider-containment");
const token = `grant-${randomBytes(32).toString("hex")}`;
const secretSentinel = `provider-${randomBytes(32).toString("hex")}`;

function run(args, options = {}) {
  return execFileSync(docker, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    ...options
  });
}

function hardened(name, network) {
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    network,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "268435456",
    "--cpus",
    "1",
    "--user",
    "65534:65534",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216",
    "--mount",
    `type=bind,src=${fixture},dst=/fixture,readonly`
  ];
}

let relay;
try {
  run(["network", "create", "--internal", internal]);
  run(["network", "create", egress]);
  relay = spawn(docker, [...hardened(relayName, egress), image, "node", "/fixture/relay.mjs"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
  let relayRunning = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      relayRunning =
        run(["container", "inspect", relayName, "--format", "{{.State.Running}}"], {
          stdio: ["ignore", "pipe", "ignore"]
        }).trim() === "true";
      if (relayRunning) break;
    } catch {
      // Docker may not have created the container yet.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (!relayRunning) throw new Error("Provider containment relay failed to start");
  run(["network", "connect", "--alias", "relay", internal, relayName]);
  relay.stdin.write(
    `${JSON.stringify({ schemaVersion: 1, token, providerSecret: secretSentinel })}\n`
  );
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  const probe = JSON.parse(
    run([...hardened(`pp-proof-agent-${suffix}`, internal), image, "node", "/fixture/probe.mjs"], {
      input: JSON.stringify({ relayHost: "relay", token, secretSentinel })
    })
  );
  const failed = Object.entries(probe)
    .filter(([key, value]) => key !== "schemaVersion" && value !== true)
    .map(([key]) => key);
  if (failed.length > 0) throw new Error(`Provider containment failed: ${failed.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, proof: probe })}\n`);
} finally {
  relay?.kill("SIGKILL");
  for (const target of [relayName]) {
    try {
      run(["rm", "--force", target], { stdio: "ignore" });
    } catch {
      // The --rm container may already be gone.
    }
  }
  for (const network of [internal, egress]) {
    try {
      run(["network", "rm", network], { stdio: "ignore" });
    } catch {
      // Cleanup is idempotent after partial startup.
    }
  }
}
