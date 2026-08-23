import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease } from "./build-release.mjs";
import { inspectRelease } from "./inspect-release.mjs";

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const temporary = mkdtempSync(join(tmpdir(), "parallelplay-reproducible-"));
try {
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  buildRelease(first);
  buildRelease(second);
  inspectRelease(first);
  inspectRelease(second);
  const firstFiles = readdirSync(first).sort();
  const secondFiles = readdirSync(second).sort();
  if (JSON.stringify(firstFiles) !== JSON.stringify(secondFiles)) {
    throw new Error("Reproducible builds produced different file sets");
  }
  const differences = firstFiles.filter(
    (name) => digest(join(first, name)) !== digest(join(second, name))
  );
  if (differences.length) throw new Error(`Reproducibility mismatch: ${differences.join(", ")}`);
  process.stdout.write(`${JSON.stringify({ ok: true, files: firstFiles.length })}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
