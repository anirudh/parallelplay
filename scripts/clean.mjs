import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

for (const parent of ["packages", "apps"]) {
  const root = resolve(parent);
  for (const entry of (await import("node:fs")).readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = resolve(root, entry.name, "dist");
    if (!target.startsWith(`${root}/`) || target === root)
      throw new Error("Refusing unsafe clean target");
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
