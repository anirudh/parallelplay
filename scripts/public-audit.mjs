import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(".");
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".parallelplay-release",
  ".parallelplay-conformance"
]);
const forbiddenNames = [["staff", "plane"].join(""), ["hob", "bes"].join("")];
const failures = [];
let scannedFiles = 0;
let scannedBytes = 0;

function scanText(label, text) {
  const lower = text.toLowerCase();
  for (const name of forbiddenNames) {
    if (lower.includes(name)) failures.push(`${label}: contains excluded predecessor identity`);
  }
  if (/\bslice[ _-]?[2-9]\b/i.test(text))
    failures.push(`${label}: contains predecessor stage identity`);
  const checks = [
    [/\/Users\/[A-Za-z0-9._-]+/, "absolute macOS user path"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i, "private key"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, "GitHub token"],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, "GitHub token"],
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, "provider key"],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "provider key"],
    [/\bAKIA[0-9A-Z]{16}\b/, "cloud access key"],
    [
      /\b(?:password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i,
      "secret-like assignment"
    ]
  ];
  for (const [pattern, description] of checks) {
    if (pattern.test(text)) failures.push(`${label}: contains ${description}`);
  }
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi)) {
    const domain = match[1]?.toLowerCase() ?? "";
    if (
      ![
        "example.com",
        "example.test",
        "parallelplay.invalid",
        "local.invalid",
        "users.noreply.github.com"
      ].includes(domain)
    ) {
      failures.push(`${label}: contains a non-synthetic email address`);
    }
  }
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const label = relative(root, path);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || lstatSync(path).isSymbolicLink()) {
      failures.push(`${label}: non-regular file is not allowed`);
      continue;
    }
    if (/\.(?:db|sqlite|sqlite3|log|pem|key|p12|pfx|har)$/i.test(entry.name)) {
      failures.push(`${label}: forbidden retained artifact type`);
      continue;
    }
    const bytes = readFileSync(path);
    scannedFiles += 1;
    scannedBytes += bytes.length;
    if (bytes.length > 8 * 1024 * 1024) failures.push(`${label}: unexpectedly large tracked input`);
    if (!bytes.includes(0)) scanText(label, bytes.toString("utf8"));
  }
}

walk(root);

for (const workflow of readdirSync(resolve(".github/workflows"))) {
  const path = resolve(".github/workflows", workflow);
  const text = readFileSync(path, "utf8");
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)) {
    if (!/@[a-f0-9]{40}$/.test(match[1] ?? "")) {
      failures.push(
        `.github/workflows/${workflow}: action is not pinned by immutable commit: ${match[1]}`
      );
    }
  }
}

for (const parent of ["packages", "apps"]) {
  for (const entry of readdirSync(resolve(parent), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = resolve(parent, entry.name, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.license !== "MIT")
      failures.push(`${relative(root, manifestPath)}: license must be MIT`);
  }
}

let gitObjects = 0;
try {
  const roots = execFileSync("git", ["rev-list", "--max-parents=0", "--all"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  if (roots.length !== 1)
    failures.push(
      `git: public product must descend from exactly one fresh root, observed ${String(roots.length)}`
    );
  execFileSync("git", ["fsck", "--full", "--strict"], { stdio: "ignore" });
  const objects = execFileSync("git", ["rev-list", "--objects", "--all"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const line of objects) {
    const object = line.split(" ")[0];
    if (!object) continue;
    const type = execFileSync("git", ["cat-file", "-t", object], { encoding: "utf8" }).trim();
    if (type !== "blob" && type !== "commit" && type !== "tag") continue;
    const size = Number(
      execFileSync("git", ["cat-file", "-s", object], { encoding: "utf8" }).trim()
    );
    if (size > 8 * 1024 * 1024) {
      failures.push(`git object ${object}: unexpectedly large`);
      continue;
    }
    scanText(
      `git object ${object}`,
      execFileSync("git", ["cat-file", "-p", object], { encoding: "utf8" })
    );
    gitObjects += 1;
  }
} catch {
  // A not-yet-committed extraction workspace is audited as a tree. Release CI requires one fresh root.
}

if (failures.length) {
  for (const failure of [...new Set(failures)].sort())
    process.stderr.write(`AUDIT FAILURE: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: true, scannedFiles, scannedBytes, gitObjects })}\n`);
}
