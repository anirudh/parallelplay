import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [firstArgument, secondArgument] = process.argv.slice(2);
if (!firstArgument || !secondArgument) {
  throw new Error("Usage: verify-images-reproducible.mjs <first> <second>");
}
const first = resolve(firstArgument);
const second = resolve(secondArgument);
const files = (directory) => readdirSync(directory).sort();
const left = files(first);
const right = files(second);
if (JSON.stringify(left) !== JSON.stringify(right)) {
  throw new Error("Provider OCI builds produced different file sets");
}
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const differences = left.filter((name) => digest(join(first, name)) !== digest(join(second, name)));
if (differences.length > 0) {
  throw new Error(`Provider OCI reproducibility mismatch: ${differences.join(", ")}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, files: left.length })}\n`);
