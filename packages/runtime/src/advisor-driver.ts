import { spawn } from "node:child_process";
import {
  AdvisorRecommendationOutputV1Schema,
  canonicalDigest,
  type AdvisorCaseInputV1,
  type AdvisorDriverReceiptV1,
  type AdvisorRecommendationOutputV1,
  type AdvisorSubjectState
} from "@parallelplay/kernel";
import { dockerPreflight } from "./generic-command-driver.js";

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface AdvisorAdapterRequest {
  subject: AdvisorSubjectState;
  input: AdvisorCaseInputV1;
}

export interface AdvisorAdapterResult {
  output: AdvisorRecommendationOutputV1;
  receipt: AdvisorDriverReceiptV1;
}

export interface AdvisorAdapter {
  readonly name: string;
  invoke(request: AdvisorAdapterRequest): Promise<AdvisorAdapterResult>;
}

export interface ContainedAdvisorDriverOptions {
  dockerBinary?: string;
  clock?: { now(): Date };
}

export interface ConformanceAdvisorDriverOptions {
  select?: (input: AdvisorCaseInputV1) => AdvisorRecommendationOutputV1;
  clock?: { now(): Date };
}

function collect(
  executable: string,
  args: string[],
  input: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const stop = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      reject(error);
    };
    const timeout = setTimeout(() => stop(new Error("Advisor invocation timed out")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > Math.min(MAX_STDOUT_BYTES, maxOutputBytes)) {
        return stop(new Error("Advisor output exceeds its approved byte limit"));
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    child.once("error", stop);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 255
      });
    });
    child.stdin.end(input);
  });
}

function subjectReference(subject: AdvisorSubjectState) {
  return {
    kind: "advisor_subject" as const,
    id: subject.subject.subjectId,
    digest: subject.subjectDigest
  };
}

export class ContainedAdvisorDriver implements AdvisorAdapter {
  readonly name = "contained-advisor";
  readonly #docker: string;
  readonly #clock: { now(): Date };

  constructor(options: ContainedAdvisorDriverOptions = {}) {
    this.#docker = options.dockerBinary ?? "docker";
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async invoke(request: AdvisorAdapterRequest): Promise<AdvisorAdapterResult> {
    const { subject, input } = request;
    const serializedInput = `${JSON.stringify(input)}\n`;
    if (Buffer.byteLength(serializedInput) > subject.subject.maxInputBytes) {
      throw new Error("Advisor input exceeds its approved byte limit");
    }
    const preflight = await dockerPreflight(subject.subject.adapter.image, this.#docker);
    if (!preflight.ok) {
      throw new Error(`Advisor Docker preflight failed: ${preflight.failures.join("; ")}`);
    }
    const startedAt = this.#clock.now().toISOString();
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    const args = [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "268435456",
      "--cpus",
      "1",
      "--user",
      `${String(uid)}:${String(gid)}`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=16777216",
      "-i",
      subject.subject.adapter.image,
      ...subject.subject.adapter.argv
    ];
    const execution = await collect(
      this.#docker,
      args,
      serializedInput,
      subject.subject.inference.timeoutMs,
      subject.subject.inference.maxOutputBytes
    );
    const completedAt = this.#clock.now().toISOString();
    if (execution.exitCode !== 0) {
      throw new Error(
        `Advisor exited ${String(execution.exitCode)}${execution.stderr ? `: ${execution.stderr.slice(0, 1_000)}` : ""}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(execution.stdout) as unknown;
    } catch {
      throw new Error("Advisor output is not one valid JSON value");
    }
    const output = AdvisorRecommendationOutputV1Schema.parse(parsed);
    return {
      output,
      receipt: {
        schemaVersion: 1,
        subjectRef: subjectReference(subject),
        inputDigest: canonicalDigest(input),
        outputDigest: canonicalDigest(output),
        exitCode: execution.exitCode,
        startedAt,
        completedAt,
        usage: { status: "unavailable", reason: "Adapter did not report trusted token usage" }
      }
    };
  }
}

export class ConformanceAdvisorDriver implements AdvisorAdapter {
  readonly name = "conformance-advisor";
  readonly #select: (input: AdvisorCaseInputV1) => AdvisorRecommendationOutputV1;
  readonly #clock: { now(): Date };

  constructor(options: ConformanceAdvisorDriverOptions = {}) {
    this.#select =
      options.select ??
      (() => ({
        kind: "abstain",
        reasonCode: "insufficient_evidence",
        summary: "Conformance adapter abstained",
        policyCitations: [],
        precedentCitations: [],
        evidenceCitations: []
      }));
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async invoke(request: AdvisorAdapterRequest): Promise<AdvisorAdapterResult> {
    const startedAt = this.#clock.now().toISOString();
    const output = AdvisorRecommendationOutputV1Schema.parse(this.#select(request.input));
    const completedAt = this.#clock.now().toISOString();
    return {
      output,
      receipt: {
        schemaVersion: 1,
        subjectRef: subjectReference(request.subject),
        inputDigest: canonicalDigest(request.input),
        outputDigest: canonicalDigest(output),
        exitCode: 0,
        startedAt,
        completedAt,
        usage: { status: "unavailable", reason: "Conformance adapter has no token meter" }
      }
    };
  }
}
