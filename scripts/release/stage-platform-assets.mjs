import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [inputArgument, outputArgument, mode = "platform"] = process.argv.slice(2);
if (!inputArgument || !outputArgument || !["base", "platform"].includes(mode)) {
  throw new Error("Usage: stage-platform-assets.mjs <input> <output> <base|platform>");
}

const input = resolve(inputArgument);
const output = resolve(outputArgument);
if (output === resolve(".") || output === resolve("/"))
  throw new Error("Refusing unsafe staging output");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const files = readdirSync(input).sort();
const selected =
  mode === "base"
    ? files.filter((name) => !["SHA256SUMS", "build-manifest.json"].includes(name))
    : files.filter((name) => /^parallelplay-cli-.+\.(?:tar\.gz|spdx\.json)$/.test(name));

if (selected.length === 0) throw new Error("No release assets selected");
for (const name of selected) copyFileSync(join(input, name), join(output, basename(name)));
process.stdout.write(`${JSON.stringify({ ok: true, mode, files: selected })}\n`);
