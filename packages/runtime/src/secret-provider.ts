import { randomBytes } from "node:crypto";
import type { SecretHandleV1, SecretProviderV1, SecretReferenceV1 } from "@parallelplay/contracts";

export interface EnvironmentSecretProviderOptions {
  environment?: NodeJS.ProcessEnv;
  defaultTtlMs?: number;
  clock?: { now(): Date };
}

interface StoredSecretHandle {
  readonly value: string;
  readonly expiresAt: string;
  readonly purpose: string;
  readonly allowedConsumer: string;
  readonly runId: string;
}

export class EnvironmentSecretProvider implements SecretProviderV1 {
  readonly name = "environment";
  readonly #environment: NodeJS.ProcessEnv;
  readonly #defaultTtlMs: number;
  readonly #clock: { now(): Date };
  readonly #handles = new Map<string, StoredSecretHandle>();

  constructor(options: EnvironmentSecretProviderOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#defaultTtlMs = options.defaultTtlMs ?? 15 * 60_000;
    this.#clock = options.clock ?? { now: () => new Date() };
    if (this.#defaultTtlMs < 1_000 || this.#defaultTtlMs > 86_400_000) {
      throw new TypeError("Secret handle TTL must be between 1 second and 24 hours");
    }
  }

  issueHandle(
    reference: SecretReferenceV1,
    context: { runId: string; now: string }
  ): SecretHandleV1 {
    const value = this.#environment[reference.name];
    if (!value) throw new Error(`Required environment secret ${reference.name} is unavailable`);
    const now = new Date(context.now);
    if (!Number.isFinite(now.getTime())) throw new TypeError("Secret handle time is invalid");
    const handleId = `secret-${randomBytes(32).toString("hex")}`;
    const expiresAt = new Date(now.getTime() + this.#defaultTtlMs).toISOString();
    this.#handles.set(handleId, {
      value,
      expiresAt,
      purpose: reference.purpose,
      allowedConsumer: reference.allowedConsumer,
      runId: context.runId
    });
    return {
      schemaVersion: 1,
      handleId,
      expiresAt,
      purpose: reference.purpose,
      allowedConsumer: reference.allowedConsumer
    };
  }

  consume(handleId: string, consumer: string, runId: string): string {
    const handle = this.#handles.get(handleId);
    if (!handle) throw new Error("Secret handle is unknown or revoked");
    if (handle.allowedConsumer !== consumer || handle.runId !== runId) {
      throw new Error("Secret handle consumer or run binding does not match");
    }
    if (handle.expiresAt <= this.#clock.now().toISOString()) {
      this.#handles.delete(handleId);
      throw new Error("Secret handle has expired");
    }
    return handle.value;
  }

  revoke(handleId: string): void {
    this.#handles.delete(handleId);
  }
}
