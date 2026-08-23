import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceRevisionState } from "@parallelplay/kernel";
import { ManagedGitRevisionStore, initializeSourceStore } from "./source-store.js";

const directories: string[] = [];
const repositoryId = "81000000-0000-4000-8000-000000000001";
const targetId = "81000000-0000-4000-8000-000000000002";
const baseShared =
  [
    "first=base",
    ...Array.from({ length: 16 }, (_, index) => `middle-${String(index + 1)}=base`),
    "last=base"
  ].join("\n") + "\n";
const candidateAShared = baseShared.replace("first=base", "first=A");
const candidateBShared = baseShared.replace("last=base", "last=B");
const combinedShared = candidateAShared.replace("last=base", "last=B");

function uuid(value: number): string {
  return `81000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

function commit(repository: string, message: string): void {
  git(repository, "add", "--all");
  git(repository, "commit", "-m", message);
}

function state(
  captured: Awaited<ReturnType<ManagedGitRevisionStore["capture"]>>
): SourceRevisionState {
  return {
    kind: "source_revision",
    ...captured,
    capturedAt: "2026-08-22T12:00:00.000Z",
    version: 1
  };
}

async function capture(
  store: ManagedGitRevisionStore,
  repository: string,
  revisionId: string,
  key: string
): Promise<SourceRevisionState> {
  return state(
    await store.capture({
      repositoryId,
      revisionId,
      captureKey: key,
      repositoryPath: repository,
      ref: "HEAD"
    })
  );
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(["sha1", "sha256"] as const)("managed Git integration (%s)", (objectFormat) => {
  it("uses exact no-rename diffs, deterministic three-way preparation, and CAS promotion", async () => {
    const root = mkdtempSync(join(tmpdir(), `parallelplay-integration-${objectFormat}-`));
    directories.push(root);
    const repository = join(root, "repository");
    const sourceRoot = join(root, "source");
    execFileSync("git", ["init", `--object-format=${objectFormat}`, repository]);
    git(repository, "config", "user.name", "ParallelPlay Test");
    git(repository, "config", "user.email", "parallelplay@example.test");
    writeFileSync(join(repository, "shared.txt"), baseShared);
    writeFileSync(join(repository, "rename-me.txt"), "rename evidence\n");
    commit(repository, "base");
    const baseBranch = git(repository, "branch", "--show-current");
    initializeSourceStore(sourceRoot);
    const store = new ManagedGitRevisionStore(sourceRoot);
    const base = await capture(store, repository, uuid(10), "base");
    expect(base.objectFormat).toBe(objectFormat);
    await store.initializeIntegrationRef(targetId, base);

    git(repository, "checkout", "-b", "rename-test", baseBranch);
    git(repository, "mv", "rename-me.txt", "renamed.txt");
    commit(repository, "rename evidence");
    const renameCandidate = await capture(store, repository, uuid(17), "rename-candidate");
    expect(await store.candidateDiff(base, renameCandidate)).toEqual([
      expect.objectContaining({ change: "delete", path: "rename-me.txt", newOid: null }),
      expect.objectContaining({ change: "add", path: "renamed.txt", oldOid: null })
    ]);
    git(repository, "checkout", "-B", "candidate-a", base.commitOid);
    writeFileSync(join(repository, "shared.txt"), candidateAShared);
    commit(repository, "candidate A");
    const candidateA = await capture(store, repository, uuid(11), "candidate-a");
    expect(await store.candidateDiff(base, candidateA)).toEqual([
      expect.objectContaining({ change: "modify", path: "shared.txt" })
    ]);
    const first = await store.prepareIntegrationRevision({
      targetId,
      revisionId: uuid(12),
      captureKey: "prepare-a",
      baseRevision: base,
      candidateRevision: candidateA,
      expectedHeadRevision: base,
      candidateId: uuid(21),
      preparedAt: "2026-08-22T12:00:00.000Z"
    });
    expect(first).toMatchObject({
      outcome: "prepared",
      revision: { commitOid: candidateA.commitOid }
    });
    expect(
      await store.promoteIntegrationRef({
        targetId,
        repositoryId,
        expectedOldCommitOid: base.commitOid,
        newCommitOid: candidateA.commitOid
      })
    ).toEqual({ duplicate: false });

    git(repository, "checkout", "-B", "candidate-b", base.commitOid);
    writeFileSync(join(repository, "shared.txt"), candidateBShared);
    commit(repository, "candidate B");
    const candidateB = await capture(store, repository, uuid(13), "candidate-b");
    const rebased = await store.prepareIntegrationRevision({
      targetId,
      revisionId: uuid(14),
      captureKey: "prepare-b",
      baseRevision: base,
      candidateRevision: candidateB,
      expectedHeadRevision: candidateA,
      candidateId: uuid(22),
      preparedAt: "2026-08-22T12:01:00.000Z"
    });
    if (rebased.outcome !== "prepared") throw new Error("Expected a mergeable candidate");
    expect(rebased.revision.commitOid).not.toBe(candidateB.commitOid);
    expect(
      execFileSync(
        "git",
        [
          "--git-dir",
          store.repositoryPath(repositoryId),
          "show",
          `${rebased.revision.commitOid}:shared.txt`
        ],
        { encoding: "utf8" }
      )
    ).toBe(combinedShared);
    expect(
      execFileSync(
        "git",
        [
          "--git-dir",
          store.repositoryPath(repositoryId),
          "show",
          "-s",
          "--format=%P",
          rebased.revision.commitOid
        ],
        { encoding: "utf8" }
      ).trim()
    ).toBe(candidateA.commitOid);
    expect(
      await store.promoteIntegrationRef({
        targetId,
        repositoryId,
        expectedOldCommitOid: candidateA.commitOid,
        newCommitOid: rebased.revision.commitOid
      })
    ).toEqual({ duplicate: false });
    expect(
      await store.promoteIntegrationRef({
        targetId,
        repositoryId,
        expectedOldCommitOid: candidateA.commitOid,
        newCommitOid: rebased.revision.commitOid
      })
    ).toEqual({ duplicate: true });
    await expect(
      store.promoteIntegrationRef({
        targetId,
        repositoryId,
        expectedOldCommitOid: base.commitOid,
        newCommitOid: candidateB.commitOid
      })
    ).rejects.toThrow("compare-and-swap");

    git(repository, "checkout", "-B", "candidate-conflict", base.commitOid);
    writeFileSync(
      join(repository, "shared.txt"),
      baseShared.replace("first=base", "first=CONFLICT")
    );
    commit(repository, "conflicting candidate");
    const conflictCandidate = await capture(store, repository, uuid(15), "candidate-conflict");
    const conflict = await store.prepareIntegrationRevision({
      targetId,
      revisionId: uuid(16),
      captureKey: "prepare-conflict",
      baseRevision: base,
      candidateRevision: conflictCandidate,
      expectedHeadRevision: state(rebased.revision),
      candidateId: uuid(23),
      preparedAt: "2026-08-22T12:02:00.000Z"
    });
    expect(conflict).toEqual({
      outcome: "conflicted",
      mergeBaseOid: base.commitOid,
      paths: ["shared.txt"]
    });
    expect(existsSync(join(sourceRoot, "captures", `${uuid(16)}.json`))).toBe(false);
  });
});
