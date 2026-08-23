import { readFileSync } from "node:fs";

const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const policy = JSON.parse(
  readFileSync(new URL("../docs/PROVIDER_SDK_LOCK.json", import.meta.url), "utf8")
);
const failures = [];

for (const entry of policy.packages ?? []) {
  const escapedName = entry.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedVersion = entry.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\n)  '${escapedName}@${escapedVersion}':\\n    resolution: \\{integrity: ${entry.integrity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`
  );
  if (!pattern.test(lock))
    failures.push(`${entry.name}@${entry.version} does not match its evaluated lock integrity`);
}

if (failures.length) throw new Error(failures.join("\n"));
process.stdout.write(`${JSON.stringify({ ok: true, packages: policy.packages.length })}\n`);
