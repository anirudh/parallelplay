import type { Kernel } from "@parallelplay/kernel";
import {
  artifactManifestDigest,
  canonicalDigest,
  driverReceiptDigest,
  receiptIdentity,
  verificationReceiptDigest,
  verificationResultDigest
} from "@parallelplay/kernel";
import type { ArtifactStore } from "./artifact-store.js";
import type { GitRevisionStore } from "./source-store.js";
import { parseDriverJsonl } from "./generic-command-driver.js";

export interface EvidenceIntegrityResult {
  verificationId: string;
  valid: boolean;
  failures: string[];
}

export interface DriverEvidenceIntegrityResult {
  driverReceiptId: string;
  valid: boolean;
  failures: string[];
}

export async function verifyDriverEvidence(options: {
  kernel: Kernel;
  sourceStore: GitRevisionStore;
  artifactStore: ArtifactStore;
  driverReceiptId: string;
}): Promise<DriverEvidenceIntegrityResult> {
  const failures: string[] = [];
  const state = await options.kernel.getState({
    kind: "driver_receipt",
    id: options.driverReceiptId
  });
  if (state?.kind !== "driver_receipt") {
    return {
      driverReceiptId: options.driverReceiptId,
      valid: false,
      failures: ["driver receipt missing"]
    };
  }
  if (driverReceiptDigest(state.receipt) !== state.receiptDigest) {
    failures.push("driver receipt digest mismatch");
  }
  if (
    state.receipt.receiptDigest !== state.receiptDigest ||
    state.receipt.baseRevisionId !== state.baseRevisionId ||
    state.receipt.candidateRevisionId !== state.candidateRevisionId ||
    state.receipt.outcome !== state.outcome ||
    state.receipt.terminalReason !== state.terminalReason
  ) {
    failures.push("driver receipt projection mismatch");
  }
  const base = await options.kernel.getState({
    kind: "source_revision",
    id: state.baseRevisionId
  });
  if (base?.kind !== "source_revision") failures.push("base revision missing");
  else {
    if (base.revisionDigest !== state.receipt.baseRevisionDigest) {
      failures.push("base revision digest mismatch");
    }
    const result = await options.sourceStore.verify(base);
    if (!result.valid) failures.push(result.reason ?? "base revision invalid");
  }
  if (state.candidateRevisionId) {
    const candidate = await options.kernel.getState({
      kind: "source_revision",
      id: state.candidateRevisionId
    });
    if (candidate?.kind !== "source_revision") failures.push("candidate revision missing");
    else {
      if (candidate.revisionDigest !== state.receipt.candidateRevisionDigest) {
        failures.push("candidate revision digest mismatch");
      }
      const result = await options.sourceStore.verify(candidate);
      if (!result.valid) failures.push(result.reason ?? "candidate revision invalid");
    }
  } else if (state.receipt.candidateRevisionDigest !== null) {
    failures.push("candidate revision digest exists without a candidate");
  }
  const manifest = (
    await options.kernel.listArtifactManifests({ attemptId: state.attemptId })
  ).find((value) => value.producer === "agent");
  if (!manifest) failures.push("agent artifact manifest missing");
  else {
    const digest = artifactManifestDigest(manifest.entries);
    if (digest !== manifest.manifestDigest)
      failures.push("agent artifact manifest digest mismatch");
    if (
      artifactManifestDigest(manifest.entries) !== artifactManifestDigest(state.receipt.artifacts)
    ) {
      failures.push("driver receipt artifact manifest mismatch");
    }
    failures.push(...options.artifactStore.verify(manifest.entries).failures);
    const protocol = manifest.entries.find((entry) => entry.path === "driver/protocol.jsonl");
    if (!protocol) failures.push("driver protocol artifact missing");
    else {
      try {
        const events = parseDriverJsonl(
          Buffer.from(options.artifactStore.read(protocol)).toString("utf8")
        );
        if (events.length !== state.receipt.eventCount)
          failures.push("driver event count mismatch");
        if (canonicalDigest(events) !== state.receipt.eventStreamDigest) {
          failures.push("driver event stream digest mismatch");
        }
      } catch (error) {
        if (state.receipt.outcome !== "protocol_invalid") {
          failures.push(
            error instanceof Error ? error.message : "driver protocol artifact is invalid"
          );
        } else if (
          state.receipt.eventCount !== 0 ||
          state.receipt.eventStreamDigest !== canonicalDigest([])
        ) {
          failures.push("invalid protocol receipt has inconsistent event evidence");
        }
      }
    }
  }
  return {
    driverReceiptId: state.driverReceiptId,
    valid: failures.length === 0,
    failures
  };
}

export async function verifyEvidence(options: {
  kernel: Kernel;
  sourceStore: GitRevisionStore;
  artifactStore: ArtifactStore;
  verificationId: string;
}): Promise<EvidenceIntegrityResult> {
  const failures: string[] = [];
  const verification = await options.kernel.getState({
    kind: "verification",
    id: options.verificationId
  });
  if (verification?.kind !== "verification") {
    return {
      verificationId: options.verificationId,
      valid: false,
      failures: ["verification missing"]
    };
  }
  const revision = await options.kernel.getState({
    kind: "source_revision",
    id: verification.sourceRevisionId
  });
  if (revision?.kind !== "source_revision") failures.push("source revision missing");
  else {
    const result = await options.sourceStore.verify(revision);
    if (!result.valid) failures.push(result.reason ?? "source revision invalid");
  }
  if (!verification.artifactManifestId || !verification.result) {
    failures.push("verification has no terminal receipt");
  } else {
    const manifest = await options.kernel.getState({
      kind: "artifact_manifest",
      id: verification.artifactManifestId
    });
    if (manifest?.kind !== "artifact_manifest") failures.push("artifact manifest missing");
    else {
      const digest = artifactManifestDigest(manifest.entries);
      if (digest !== manifest.manifestDigest) failures.push("artifact manifest digest mismatch");
      if (verification.result.artifactManifestDigest !== digest) {
        failures.push("receipt artifact digest mismatch");
      }
      failures.push(...options.artifactStore.verify(manifest.entries).failures);
      const resultDigest = verificationResultDigest(verification.result);
      if (resultDigest !== verification.resultDigest) failures.push("result digest mismatch");
      const receiptDigest = verificationReceiptDigest(
        receiptIdentity(verification, manifest.artifactManifestId, digest, resultDigest)
      );
      if (receiptDigest !== verification.receiptDigest) failures.push("receipt digest mismatch");
    }
  }
  return { verificationId: verification.verificationId, valid: failures.length === 0, failures };
}
