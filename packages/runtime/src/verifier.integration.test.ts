import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerifierContractSchema,
  verificationReceiptDigest,
  type SourceRevisionState,
  type VerifierContract
} from "@parallelplay/kernel";
import { FileArtifactStore, initializeArtifactStore } from "./artifact-store.js";
import { ManagedGitRevisionStore, initializeSourceStore } from "./source-store.js";
import { TrustedCommandVerifier, VerifierTimeoutError } from "./verifier.js";

const repositoryId = "00000000-0000-4000-8000-000000000101";
const revisionId = "00000000-0000-4000-8000-000000000102";
const secondRevisionId = "00000000-0000-4000-8000-000000000103";
const verificationId = "00000000-0000-4000-8000-000000000104";
const attemptId = "00000000-0000-4000-8000-000000000105";
const runId = "00000000-0000-4000-8000-000000000106";
const jobId = "00000000-0000-4000-8000-000000000107";
const workflowId = "00000000-0000-4000-8000-000000000108";
const directories: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commit(repository: string, script: string, message: string): void {
  const path = join(repository, "verify.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  execFileSync("git", ["-C", repository, "add", "verify.sh"]);
  execFileSync("git", ["-C", repository, "commit", "-m", message]);
}

async function fixture(
  script: string,
  objectFormat: "sha1" | "sha256" = "sha1"
): Promise<{
  repository: string;
  sourceStore: ManagedGitRevisionStore;
  artifactStore: FileArtifactStore;
  revision: SourceRevisionState;
}> {
  const root = mkdtempSync(join(tmpdir(), "parallelplay-verifier-"));
  directories.push(root);
  const repository = join(root, "repository");
  const sourceRoot = join(root, "source");
  const artifactRoot = join(root, "artifacts");
  execFileSync("git", ["init", `--object-format=${objectFormat}`, repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "ParallelPlay Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "parallelplay@example.test"]);
  commit(repository, script, "first revision");
  initializeSourceStore(sourceRoot);
  initializeArtifactStore(artifactRoot);
  const sourceStore = new ManagedGitRevisionStore(sourceRoot);
  const captured = await sourceStore.capture({
    repositoryId,
    revisionId,
    captureKey: "first-capture",
    repositoryPath: repository,
    ref: "HEAD"
  });
  return {
    repository,
    sourceStore,
    artifactStore: new FileArtifactStore(artifactRoot),
    revision: {
      kind: "source_revision",
      ...captured,
      capturedAt: "2026-08-19T12:00:00.000Z",
      version: 1
    }
  };
}

function contract(overrides: Partial<VerifierContract> = {}): VerifierContract {
  return {
    mode: "verify",
    argv: ["./verify.sh"],
    cwd: ".",
    timeoutMs: 5_000,
    environment: {},
    toolProbes: [],
    ...overrides
  };
}

async function verify(
  sourceStore: ManagedGitRevisionStore,
  artifactStore: FileArtifactStore,
  revision: SourceRevisionState,
  verifierContract: VerifierContract
) {
  return new TrustedCommandVerifier({ sourceStore, artifactStore }).verify({
    verificationId,
    attemptId,
    sourceRevision: revision,
    verifierContract,
    verifierContractDigest: sha256(JSON.stringify(verifierContract)),
    remainingAttemptMs: 5_000
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("immutable revisions and trusted verification", () => {
  it("keeps captured commits immutable after branch movement and source removal", async () => {
    const { repository, sourceStore, revision } = await fixture("#!/bin/sh\nexit 0\n");
    commit(repository, "#!/bin/sh\nexit 7\n", "second revision");
    const second = await sourceStore.capture({
      repositoryId,
      revisionId: secondRevisionId,
      captureKey: "second-capture",
      repositoryPath: repository,
      ref: "HEAD"
    });
    expect(second.commitOid).not.toBe(revision.commitOid);
    expect(
      await sourceStore.capture({
        repositoryId,
        revisionId,
        captureKey: "first-capture",
        repositoryPath: repository,
        ref: "HEAD"
      })
    ).toMatchObject({ commitOid: revision.commitOid, treeOid: revision.treeOid });
    await expect(
      sourceStore.capture({
        repositoryId,
        revisionId,
        captureKey: "conflicting-capture",
        repositoryPath: repository,
        ref: "HEAD"
      })
    ).rejects.toThrow("Revision ID already pins another commit");
    expect((await sourceStore.verify(revision)).valid).toBe(true);
    expect(
      (await sourceStore.verify({ ...revision, ...second, kind: "source_revision" })).valid
    ).toBe(true);
    rmSync(repository, { recursive: true, force: true });
    expect((await sourceStore.verify(revision)).valid).toBe(true);
    const checkoutRoot = mkdtempSync(join(tmpdir(), "parallelplay-checkout-"));
    directories.push(checkoutRoot);
    const checkout = join(checkoutRoot, "checkout");
    await sourceStore.checkout(revision, checkout);
    try {
      expect(readFileSync(join(checkout, "verify.sh"), "utf8")).toContain("exit 0");
    } finally {
      await sourceStore.removeCheckout(revision, checkout);
    }
  });

  it("produces stable evidence digests for repeatable verification", async () => {
    const { sourceStore, artifactStore, revision } = await fixture(
      "#!/bin/sh\nprintf deterministic\nprintf warning >&2\nexit 0\n"
    );
    const verifierContract = contract();
    const first = await verify(sourceStore, artifactStore, revision, verifierContract);
    const second = await verify(sourceStore, artifactStore, revision, verifierContract);
    expect(first.result).toEqual(second.result);
    expect(first.resultDigest).toBe(second.resultDigest);
    expect(first.entries).toEqual(second.entries);
    const verifierContractDigest = sha256(JSON.stringify(verifierContract));
    const receipt = (result: typeof first): string =>
      verificationReceiptDigest({
        verificationId,
        runId,
        jobId,
        attemptId,
        workflowId,
        workflowVersion: 1,
        workflowDigest: sha256("workflow"),
        sourceRevisionId: revision.revisionId,
        verifierContractDigest,
        artifactManifestId: verificationId,
        artifactManifestDigest: result.result.artifactManifestDigest,
        resultDigest: result.resultDigest
      });
    expect(receipt(first)).toBe(receipt(second));
    expect(first.result).toMatchObject({ outcome: "passed", exitCode: 0, failureReason: null });
    expect(artifactStore.verify(first.entries)).toEqual({ valid: true, failures: [] });
  });

  it("captures and verifies a SHA-256 Git repository", async () => {
    const { sourceStore, artifactStore, revision } = await fixture("#!/bin/sh\nexit 0\n", "sha256");
    expect(revision).toMatchObject({ objectFormat: "sha256" });
    expect(revision.commitOid).toHaveLength(64);
    expect(revision.treeOid).toHaveLength(64);
    expect(await sourceStore.verify(revision)).toEqual({ valid: true, reason: null });
    expect((await verify(sourceStore, artifactStore, revision, contract())).result).toMatchObject({
      outcome: "passed",
      exitCode: 0,
      failureReason: null
    });
  });

  it.each([
    {
      name: "nonzero verifier",
      script: "#!/bin/sh\nexit 9\n",
      expected: { outcome: "failed", failureReason: "verifier_exit_9" }
    },
    {
      name: "source mutation",
      script: "#!/bin/sh\nprintf changed > mutation.txt\nexit 0\n",
      expected: { outcome: "invalid", failureReason: "source_mutated" }
    },
    {
      name: "environment-contract mutation",
      script:
        '#!/bin/sh\n/bin/chmod 600 "$PARALLELPLAY_VERIFICATION_CONTRACT"\nprintf changed > "$PARALLELPLAY_VERIFICATION_CONTRACT"\nexit 0\n',
      expected: { outcome: "invalid", failureReason: "environment_contract_mutated" }
    }
  ])(
    "classifies $name as evidence rather than infrastructure failure",
    async ({ script, expected }) => {
      const { sourceStore, artifactStore, revision } = await fixture(script);
      const result = await verify(sourceStore, artifactStore, revision, contract());
      expect(result.result).toMatchObject(expected);
      expect(artifactStore.verify(result.entries)).toEqual({ valid: true, failures: [] });
    }
  );

  it("invalidates a mismatched tool probe and bounds verifier time", async () => {
    const { sourceStore, artifactStore, revision } = await fixture(
      "#!/bin/sh\n/bin/sleep 2\nexit 0\n"
    );
    const mismatch = await verify(
      sourceStore,
      artifactStore,
      revision,
      contract({
        argv: ["/bin/true"],
        toolProbes: [
          {
            name: "shell",
            argv: ["/bin/sh", "-c", "printf actual"],
            expectedExitCode: 0,
            expectedStdoutDigest: sha256("expected")
          }
        ]
      })
    );
    expect(mismatch.result).toMatchObject({
      outcome: "invalid",
      failureReason: "environment_mismatch:shell"
    });
    await expect(
      verify(sourceStore, artifactStore, revision, contract({ timeoutMs: 250 }))
    ).rejects.toBeInstanceOf(VerifierTimeoutError);
  });

  it("rejects escaping contracts and never interprets argv through a shell", async () => {
    expect(
      VerifierContractSchema.safeParse({
        ...contract(),
        argv: ["./../outside"],
        cwd: "nested/../outside",
        environment: { HOME: "/tmp/override" }
      }).success
    ).toBe(false);
    const { repository, sourceStore, artifactStore, revision } =
      await fixture("#!/bin/sh\nexit 0\n");
    const outside = join(repository, "..", "shell-injection-created");
    const result = await verify(
      sourceStore,
      artifactStore,
      revision,
      contract({ argv: ["/bin/echo", `; /usr/bin/touch ${outside}`] })
    );
    expect(result.result.outcome).toBe("passed");
    expect(existsSync(outside)).toBe(false);
  });

  it("turns oversized verifier output into bounded invalid evidence", async () => {
    const { sourceStore, artifactStore, revision } = await fixture(
      "#!/bin/sh\n/usr/bin/yes x | /usr/bin/head -c 11000000\n"
    );
    const result = await verify(sourceStore, artifactStore, revision, contract());
    expect(result.result).toMatchObject({
      outcome: "invalid",
      failureReason: "evidence_output_limit"
    });
    expect(result.entries.find((entry) => entry.role === "stdout")?.size).toBeLessThanOrEqual(
      10 * 1024 * 1024
    );
  });
});
