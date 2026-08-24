import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionManifestV1, OutboundAdapterV1 } from "@parallelplay/contracts";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import { SqliteOutboundAuthority } from "./outbound-authority.js";

const directories: string[] = [];
const adapterManifest: ExtensionManifestV1 = {
  schemaVersion: 1,
  id: "github-app",
  displayName: "GitHub App",
  extensionVersion: "0.1.0",
  kind: "adapter",
  contract: { name: "outbound-adapter-v1", version: 1 },
  artifact: {
    mediaType: "application/vnd.parallelplay.builtin+json",
    reference: "builtin:github-app",
    sha256: "a".repeat(64)
  },
  configurationSchemaDigest: "b".repeat(64),
  capabilities: [],
  provenance: {
    sourceRepository: "https://github.com/anirudh/parallelplay",
    sourceRevision: "c".repeat(64),
    sbomDigest: "d".repeat(64),
    attestationDigest: "e".repeat(64)
  },
  conformance: {
    suiteVersion: "0.1.0",
    reportDigest: "f".repeat(64),
    approvedRegistryDigest: null
  }
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("authoritative outbound effects", () => {
  it("requires a promoted exact policy and replays a digest-bound receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "parallelplay-outbound-"));
    directories.push(directory);
    const databasePath = join(directory, "parallelplay.db");
    const now = new Date("2026-08-23T12:00:00.000Z");
    await migrateDatabase({ databasePath, clock: { now: () => now } });
    const authority = SqliteOutboundAuthority.open({ databasePath, clock: { now: () => now } });
    const promotion = authority.promotePolicy(
      {
        schemaVersion: 1,
        policyRevisionId: "10000000-0000-4000-8000-000000000001",
        name: "Fixture comments",
        allowedActions: ["github.comment.create"],
        targets: ["anirudh/parallelplay-fixture"],
        expiresAt: "2026-08-24T12:00:00.000Z"
      },
      { kind: "operator", id: "operator-1" }
    );
    const payload = {
      action: "github.comment.create",
      issueNumber: 1,
      body: "Passed",
      allowedLinkHosts: []
    };
    const request = {
      schemaVersion: 1 as const,
      adapterId: "github-app",
      effectKey: "fixture-comment-1",
      action: "github.comment.create" as const,
      target: "anirudh/parallelplay-fixture",
      payload,
      payloadDigest: canonicalDigest(payload),
      preconditionDigest: "a".repeat(64),
      policyPromotionDigest: promotion.promotionDigest
    };
    await expect(authority.authorize(request)).resolves.toMatchObject({ status: "authorized" });
    const unsigned = {
      schemaVersion: 1 as const,
      adapterId: request.adapterId,
      effectKey: request.effectKey,
      action: request.action,
      payloadDigest: request.payloadDigest,
      externalId: "comment-1",
      requestId: "github-request-1",
      observedStateDigest: "b".repeat(64),
      acceptedAt: now.toISOString()
    };
    await authority.recordReceipt(request, {
      ...unsigned,
      receiptDigest: canonicalDigest(unsigned)
    });
    let reconciliationCalls = 0;
    const adapter: OutboundAdapterV1 = {
      manifest: adapterManifest,
      async deliver() {
        throw new Error("not used");
      },
      async reconcile(input) {
        reconciliationCalls += 1;
        expect(input.effect).toEqual(request);
        expect(input.priorReceipt?.receiptDigest).toBe(canonicalDigest(unsigned));
        return {
          schemaVersion: 1,
          effectKey: request.effectKey,
          status: "observed_exact",
          externalId: unsigned.externalId,
          observedStateDigest: unsigned.observedStateDigest
        };
      },
      close: () => Promise.resolve()
    };
    await expect(authority.reconcileEffect(request.effectKey, adapter)).resolves.toMatchObject({
      status: "observed_exact"
    });
    expect(reconciliationCalls).toBe(1);
    const before = authority.snapshot();
    expect(before.effects).toEqual([
      expect.objectContaining({
        effectKey: request.effectKey,
        status: "delivered",
        failureCount: 0
      })
    ]);
    authority.close();

    const replayed = SqliteOutboundAuthority.open({ databasePath, clock: { now: () => now } });
    expect(replayed.snapshot()).toEqual(before);
    replayed.close();
  });

  it("rejects a mismatched adapter before any reconciliation call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "parallelplay-outbound-reconcile-"));
    directories.push(directory);
    const databasePath = join(directory, "parallelplay.db");
    const now = new Date("2026-08-23T12:00:00.000Z");
    await migrateDatabase({ databasePath, clock: { now: () => now } });
    const authority = SqliteOutboundAuthority.open({ databasePath, clock: { now: () => now } });
    const promotion = authority.promotePolicy(
      {
        schemaVersion: 1,
        policyRevisionId: "10000000-0000-4000-8000-000000000004",
        name: "Fixture comments",
        allowedActions: ["github.comment.create"],
        targets: ["anirudh/parallelplay-fixture"],
        expiresAt: "2026-08-24T12:00:00.000Z"
      },
      { kind: "operator", id: "operator-1" }
    );
    const payload = {
      action: "github.comment.create" as const,
      issueNumber: 1,
      body: "Passed",
      allowedLinkHosts: []
    };
    const request = {
      schemaVersion: 1 as const,
      adapterId: "github-app",
      effectKey: "fixture-comment-reconcile",
      action: "github.comment.create" as const,
      target: "anirudh/parallelplay-fixture",
      payload,
      payloadDigest: canonicalDigest(payload),
      preconditionDigest: "a".repeat(64),
      policyPromotionDigest: promotion.promotionDigest
    };
    await authority.authorize(request);
    let called = false;
    const mismatched: OutboundAdapterV1 = {
      manifest: { ...adapterManifest, id: "signed-webhook" },
      async deliver() {
        throw new Error("not used");
      },
      async reconcile() {
        called = true;
        throw new Error("must not be called");
      },
      close: () => Promise.resolve()
    };
    await expect(authority.reconcileEffect(request.effectKey, mismatched)).rejects.toThrow(
      /identity/
    );
    expect(called).toBe(false);
    authority.close();
  });

  it("rejects a forbidden action without appending authority evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "parallelplay-outbound-ceiling-"));
    directories.push(directory);
    const databasePath = join(directory, "parallelplay.db");
    const now = new Date("2026-08-23T12:00:00.000Z");
    await migrateDatabase({ databasePath, clock: { now: () => now } });
    const authority = SqliteOutboundAuthority.open({ databasePath, clock: { now: () => now } });
    expect(() =>
      authority.promotePolicy(
        {
          schemaVersion: 1,
          policyRevisionId: "10000000-0000-4000-8000-000000000002",
          name: "Forbidden release",
          allowedActions: ["release"],
          targets: ["anirudh/parallelplay-fixture"],
          expiresAt: "2026-08-24T12:00:00.000Z"
        },
        { kind: "operator", id: "operator-1" }
      )
    ).toThrow(/global authority ceiling/);
    expect(authority.snapshot().throughPosition).toBe(0);
    authority.close();
  });
});
