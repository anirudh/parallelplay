import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const output = resolve(
  process.argv[2] ?? ".parallelplay-release/native/parallelplay-notification-bridge"
);
mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    "arm64-apple-macos12.0",
    "-module-cache-path",
    "/tmp/parallelplay-swift-module-cache",
    "native/macos-notification-bridge/main.swift",
    "-o",
    output
  ],
  { stdio: "inherit", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }
);
execFileSync(process.execPath, ["scripts/notifications/normalize-macos-bridge.mjs", output], {
  stdio: "inherit",
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
});
process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
