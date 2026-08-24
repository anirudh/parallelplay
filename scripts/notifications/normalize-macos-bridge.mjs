import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LC_UUID = 0x1b;
const MACH_HEADER_64_SIZE = 32;
const executable = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("macOS bridge executable path is required");

execFileSync("codesign", ["--remove-signature", executable], { stdio: "ignore" });
const binary = readFileSync(executable);
if (binary.readUInt32LE(0) !== 0xfeedfacf) {
  throw new Error("macOS bridge is not a little-endian 64-bit Mach-O executable");
}

const commands = binary.readUInt32LE(16);
let offset = MACH_HEADER_64_SIZE;
let uuidOffset = -1;
for (let index = 0; index < commands; index += 1) {
  if (offset + 8 > binary.length) throw new Error("macOS bridge load commands are truncated");
  const command = binary.readUInt32LE(offset);
  const size = binary.readUInt32LE(offset + 4);
  if (size < 8 || offset + size > binary.length) {
    throw new Error("macOS bridge load command is invalid");
  }
  if (command === LC_UUID) {
    if (size !== 24 || uuidOffset !== -1) throw new Error("macOS bridge UUID command is invalid");
    uuidOffset = offset + 8;
  }
  offset += size;
}
if (uuidOffset === -1) throw new Error("macOS bridge UUID command is missing");

binary.fill(0, uuidOffset, uuidOffset + 16);
const uuid = createHash("sha256").update(binary).digest().subarray(0, 16);
uuid[6] = (uuid[6] & 0x0f) | 0x50;
uuid[8] = (uuid[8] & 0x3f) | 0x80;
uuid.copy(binary, uuidOffset);
writeFileSync(executable, binary, { mode: 0o755 });
execFileSync(
  "codesign",
  [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--identifier",
    "com.anirudh.parallelplay.notification-bridge",
    executable
  ],
  { stdio: "ignore" }
);
