import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import { SqliteOutboundAuthority } from "./outbound-authority.js";

const directories: string[] = [];
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
