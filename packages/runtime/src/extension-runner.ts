import { spawn } from "node:child_process";
import { z } from "zod";

const DigestPinnedImage = z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/);

export interface OciExtensionRunnerOptions {
  dockerBinary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface OciExtensionRunRequest {
  image: string;
  argv: string[];
  input: unknown;
  cpuLimit?: number;
  memoryLimitBytes?: number;
  pidsLimit?: number;
}

export interface OciExtensionRunResult<T> {
  output: T;
  stderr: string;
  exitCode: number;
}

export function buildOciExtensionDockerArgs(request: OciExtensionRunRequest): string[] {
  const image = DigestPinnedImage.parse(request.image);
  const cpuLimit = request.cpuLimit ?? 1;
  const memoryLimitBytes = request.memoryLimitBytes ?? 268_435_456;
  const pidsLimit = request.pidsLimit ?? 64;
  return [
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
    String(pidsLimit),
    "--memory",
    String(memoryLimitBytes),
    "--cpus",
    String(cpuLimit),
    "--user",
    "65534:65534",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=16777216",
    "--entrypoint",
    "/usr/bin/env",
    image,
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C",
    "LC_ALL=C",
    ...request.argv
  ];
}

export class OciExtensionRunner {
  readonly #docker: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: OciExtensionRunnerOptions = {}) {
    this.#docker = options.dockerBinary ?? "docker";
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  }

  async run<T>(
    request: OciExtensionRunRequest,
    outputSchema: z.ZodType<T>
  ): Promise<OciExtensionRunResult<T>> {
    const input = `${JSON.stringify(request.input)}\n`;
    const args = buildOciExtensionDockerArgs(request);
    const execution = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        const child = spawn(this.#docker, args, { stdio: ["pipe", "pipe", "pipe"], env: {} });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const stop = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          child.kill("SIGKILL");
          reject(error);
        };
        const timeout = setTimeout(
          () => stop(new Error("OCI extension timed out")),
          this.#timeoutMs
        );
        child.stdout.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > this.#maxOutputBytes)
            return stop(new Error("OCI extension output is too large"));
          stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (Buffer.concat(stderr).byteLength < 65_536) stderr.push(chunk);
        });
        child.once("error", stop);
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8").slice(0, 65_536),
            exitCode: code ?? 255
          });
        });
        child.stdin.end(input);
      }
    );
    if (execution.exitCode !== 0) {
      throw new Error(`OCI extension exited ${String(execution.exitCode)}: ${execution.stderr}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(execution.stdout);
    } catch {
      throw new Error("OCI extension did not return one JSON value");
    }
    return {
      output: outputSchema.parse(parsed),
      stderr: execution.stderr,
      exitCode: execution.exitCode
    };
  }
}
