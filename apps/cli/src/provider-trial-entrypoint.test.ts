import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider trial entry point", () => {
  test("runs when addressed through a symlinked install path", () => {
    const root = mkdtempSync(join(tmpdir(), "parallelplay-provider-entrypoint-"));
    roots.push(root);
    const linkedScripts = join(root, "scripts");
    symlinkSync(resolve("scripts/pilot"), linkedScripts, "dir");

    const result = spawnSync(process.execPath, [join(linkedScripts, "provider-trial.mjs")], {
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^\{"ok":false,"error":"provider_trial_failed","diagnostic":"provider_setup_phase_internal_[a-f0-9]{12}"\}\n$/
    );
  });
});
