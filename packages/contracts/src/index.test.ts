import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_ACTION_ALLOWLIST,
  DriverEventBatchV1Schema,
  ExtensionManifestV1Schema,
  isAutomaticActionAllowed
} from "./index.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("public V1 contracts", () => {
  it("accepts a digest-bound extension manifest", () => {
    expect(
      ExtensionManifestV1Schema.parse({
        schemaVersion: 1,
        id: "fixture-driver",
        displayName: "Fixture driver",
        extensionVersion: "0.1.0",
        kind: "driver",
        contract: { name: "agent-driver-v1", version: 1 },
        artifact: {
          mediaType: "application/vnd.parallelplay.builtin+json",
          reference: "builtin:fixture-driver",
          sha256: digest("artifact")
        },
        configurationSchemaDigest: digest("config"),
        capabilities: [],
        provenance: {
          sourceRepository: "https://github.com/anirudh/parallelplay",
          sourceRevision: digest("source"),
          sbomDigest: digest("sbom"),
          attestationDigest: digest("attestation")
        },
        conformance: {
          suiteVersion: "0.1.0",
          reportDigest: digest("report"),
          approvedRegistryDigest: null
        }
      }).id
    ).toBe("fixture-driver");
  });

  it("rejects non-contiguous structured driver events", () => {
    expect(() =>
      DriverEventBatchV1Schema.parse({
        schemaVersion: 1,
        afterSequence: 0,
        status: "running",
        events: [
          {
            schemaVersion: 1,
            sequence: 2,
            occurredAt: "2026-08-23T00:00:00.000Z",
            type: "started"
          }
        ]
      })
    ).toThrow(/Expected sequence 1/);
  });

  it("enforces the hard global automatic-action ceiling", () => {
    expect(isAutomaticActionAllowed("github.draft-pr.create")).toBe(true);
    expect(isAutomaticActionAllowed("merge")).toBe(false);
    expect(isAutomaticActionAllowed("secret.change")).toBe(false);
    expect(AUTOMATIC_ACTION_ALLOWLIST.size).toBe(10);
  });
});
