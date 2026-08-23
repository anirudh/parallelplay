import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  ArtifactEntry,
  SourceRevisionState,
  VerificationReceiptIdentity,
  VerificationResultContent,
  VerifierContract
} from "@parallelplay/kernel";
import {
  artifactManifestDigest,
  canonicalArtifactEntries,
  verificationResultDigest
} from "@parallelplay/kernel";
import type { ArtifactStore } from "./artifact-store.js";
import type { GitRevisionStore } from "./source-store.js";

const OUTPUT_LIMIT = 10 * 1024 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ProcessResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  outputLimited: boolean;
}

function resolveCommandArgv(argv: string[], checkout: string): string[] {
  const executable = argv[0] ?? "";
  if (!executable.startsWith("./")) return argv;
  const resolved = realpathSync(resolve(checkout, executable.slice(2)));
  if (resolved !== checkout && !resolved.startsWith(`${checkout}${sep}`)) {
    throw new Error("Repository-relative executable escapes checkout");
  }
  return [resolved, ...argv.slice(1)];
}

function runProcess(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ProcessResult> {
  return new Promise((resolveResult) => {
    const child = execFile(
      argv[0] ?? "",
      argv.slice(1),
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "buffer",
        timeout: options.timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: OUTPUT_LIMIT
      },
      (error, stdout, stderr) => {
        const candidate = error as
          (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
        const outputLimited = candidate?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        resolveResult({
          exitCode:
            candidate === null ? 0 : typeof candidate.code === "number" ? candidate.code : null,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
          timedOut: candidate?.killed === true && !outputLimited,
          outputLimited
        });
      }
    );
    child.stdin?.end();
  });
}

export class VerifierTimeoutError extends Error {
  constructor(message = "Verifier command timed out") {
    super(message);
    this.name = "VerifierTimeoutError";
  }
}

export interface VerificationRequest {
  verificationId: string;
  attemptId: string;
  sourceRevision: SourceRevisionState;
  verifierContract: VerifierContract;
  verifierContractDigest: string;
  remainingAttemptMs: number;
}

export interface TrustedVerifierResult {
  result: VerificationResultContent;
  resultDigest: string;
  entries: ArtifactEntry[];
}

export type VerificationReceipt = VerificationReceiptIdentity;

export class TrustedCommandVerifier {
  readonly #sourceStore: GitRevisionStore;
  readonly #artifactStore: ArtifactStore;

  constructor(options: { sourceStore: GitRevisionStore; artifactStore: ArtifactStore }) {
    this.#sourceStore = options.sourceStore;
    this.#artifactStore = options.artifactStore;
  }

  async verify(request: VerificationRequest): Promise<TrustedVerifierResult> {
    const root = mkdtempSync(join(tmpdir(), "parallelplay-verify-"));
    const checkout = join(root, "checkout");
    const home = join(root, "home");
    const scratch = join(root, "tmp");
    const contractPath = join(root, "verification-contract.json");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(scratch, { mode: 0o700 });
    const contractBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        verificationId: request.verificationId,
        attemptId: request.attemptId,
        sourceRevisionId: request.sourceRevision.revisionId,
        sourceRevisionDigest: request.sourceRevision.revisionDigest,
        verifierContractDigest: request.verifierContractDigest,
        verifierContract: request.verifierContract
      })}\n`
    );
    writeFileSync(contractPath, contractBytes, { mode: 0o400 });
    const contractDigestBefore = sha256(contractBytes);
    let checkedOut = false;
    try {
      await this.#sourceStore.checkout(request.sourceRevision, checkout);
      checkedOut = true;
      const checkoutRoot = realpathSync(checkout);
      let cwd = checkoutRoot;
      let failureReason: string | null = null;
      try {
        const candidate = realpathSync(resolve(checkoutRoot, request.verifierContract.cwd));
        if (candidate !== checkoutRoot && !candidate.startsWith(`${checkoutRoot}${sep}`)) {
          failureReason = "working_directory_escapes_checkout";
        } else {
          cwd = candidate;
        }
      } catch {
        failureReason = "working_directory_invalid";
      }
      const statusBefore = await this.#sourceStore.status(checkoutRoot);
      if (statusBefore !== "") throw new Error("Managed verification checkout is not clean");
      const env: NodeJS.ProcessEnv = {
        ...request.verifierContract.environment,
        CI: "1",
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        HOME: home,
        TMPDIR: scratch,
        PARALLELPLAY_VERIFICATION_CONTRACT: contractPath,
        PARALLELPLAY_SOURCE_REVISION: request.sourceRevision.commitOid
      };
      const timeoutMs = Math.max(
        1,
        Math.min(request.verifierContract.timeoutMs, request.remainingAttemptMs)
      );
      const verifierDeadline = Date.now() + timeoutMs;
      const remainingVerifierMs = (): number => {
        const remaining = verifierDeadline - Date.now();
        if (remaining <= 0) throw new VerifierTimeoutError();
        return remaining;
      };
      let main: ProcessResult | null = null;
      if (!failureReason) {
        for (const probe of request.verifierContract.toolProbes) {
          let probeArgv: string[];
          try {
            probeArgv = resolveCommandArgv(probe.argv, checkoutRoot);
          } catch {
            failureReason = `tool_probe_invalid:${probe.name}`;
            break;
          }
          const probeResult = await runProcess(probeArgv, {
            cwd,
            env,
            timeoutMs: remainingVerifierMs()
          });
          if (probeResult.timedOut) throw new VerifierTimeoutError();
          if (
            probeResult.outputLimited ||
            probeResult.exitCode !== probe.expectedExitCode ||
            sha256(probeResult.stdout) !== probe.expectedStdoutDigest
          ) {
            main = probeResult;
            failureReason = `environment_mismatch:${probe.name}`;
            break;
          }
        }
      }
      if (!main && !failureReason) {
        let mainArgv: string[] | null = null;
        try {
          mainArgv = resolveCommandArgv(request.verifierContract.argv, checkoutRoot);
        } catch {
          failureReason = "verifier_executable_invalid";
        }
        if (mainArgv) {
          main = await runProcess(mainArgv, {
            cwd,
            env,
            timeoutMs: remainingVerifierMs()
          });
        }
      }
      main ??= {
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false,
        outputLimited: false
      };
      if (main.timedOut) throw new VerifierTimeoutError();
      if (main.outputLimited) failureReason = "evidence_output_limit";
      let statusAfter: string;
      try {
        statusAfter = await this.#sourceStore.status(checkoutRoot);
      } catch {
        statusAfter = "<unavailable>\n";
        failureReason ??= "source_status_unavailable";
      }
      const managedRevisionIntegrity = await this.#sourceStore.verify(request.sourceRevision);
      if (!managedRevisionIntegrity.valid) failureReason ??= "managed_source_changed";
      let contractBytesAfter: Buffer;
      try {
        contractBytesAfter = readFileSync(contractPath);
      } catch {
        contractBytesAfter = Buffer.from("<unavailable>\n");
        failureReason ??= "environment_contract_unavailable";
      }
      const contractDigestAfter = sha256(contractBytesAfter);
      const sourceMutated = statusAfter !== statusBefore;
      const contractMutated = contractDigestAfter !== contractDigestBefore;
      let outcome: VerificationResultContent["outcome"];
      if (failureReason || sourceMutated || contractMutated || main.exitCode === null) {
        outcome = "invalid";
        failureReason ??= sourceMutated
          ? "source_mutated"
          : contractMutated
            ? "environment_contract_mutated"
            : "malformed_process_result";
      } else if (main.exitCode === 0) {
        outcome = "passed";
      } else {
        outcome = "failed";
        failureReason = `verifier_exit_${String(main.exitCode)}`;
      }
      if (existsSync(contractPath)) chmodSync(contractPath, 0o600);
      const entries = canonicalArtifactEntries([
        this.#artifactStore.put("stdout.txt", "stdout", main.stdout.subarray(0, OUTPUT_LIMIT)),
        this.#artifactStore.put("stderr.txt", "stderr", main.stderr.subarray(0, OUTPUT_LIMIT)),
        this.#artifactStore.put("environment.json", "environment", contractBytesAfter),
        this.#artifactStore.put(
          "git-status-before.txt",
          "git_status_before",
          Buffer.from(statusBefore)
        ),
        this.#artifactStore.put(
          "git-status-after.txt",
          "git_status_after",
          Buffer.from(statusAfter)
        )
      ]);
      const manifestDigest = artifactManifestDigest(entries);
      const result: VerificationResultContent = {
        outcome,
        exitCode: main.exitCode,
        failureReason: outcome === "passed" ? null : failureReason,
        environmentDigest: sha256(contractBytes),
        sourceStatusBeforeDigest: sha256(statusBefore),
        sourceStatusAfterDigest: sha256(statusAfter),
        contractDigestBefore,
        contractDigestAfter,
        artifactManifestDigest: manifestDigest
      };
      return { result, resultDigest: verificationResultDigest(result), entries };
    } finally {
      if (checkedOut) await this.#sourceStore.removeCheckout(request.sourceRevision, checkout);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
