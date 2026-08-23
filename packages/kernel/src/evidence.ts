import { canonicalDigest } from "./canonical.js";
import type {
  Command,
  DriverReceiptSchema,
  SourceRevisionState,
  VerificationState
} from "./schema.js";
import type { z } from "zod";

export interface SourceRevisionIdentity {
  repositoryId: string;
  objectFormat: "sha1" | "sha256";
  commitOid: string;
  treeOid: string;
}

export function sourceRevisionDigest(value: SourceRevisionIdentity): string {
  return canonicalDigest({ schemaVersion: 1, ...value });
}

export type VerificationCompletion = Extract<Command, { type: "verification.complete" }>;
export type VerificationResultContent = VerificationCompletion["payload"]["result"];
export type ArtifactEntry = VerificationCompletion["payload"]["entries"][number];

export function canonicalArtifactEntries(entries: ArtifactEntry[]): ArtifactEntry[] {
  return [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

export function artifactManifestDigest(entries: ArtifactEntry[]): string {
  return canonicalDigest({ schemaVersion: 1, entries: canonicalArtifactEntries(entries) });
}

export type DriverReceiptContent = z.infer<typeof DriverReceiptSchema>;

export function driverReceiptDigest(receipt: DriverReceiptContent): string {
  const content: Record<string, unknown> = { ...receipt };
  delete content["receiptDigest"];
  return canonicalDigest(content);
}

export function verificationResultDigest(result: VerificationResultContent): string {
  return canonicalDigest({ schemaVersion: 1, ...result });
}

export interface VerificationReceiptIdentity {
  verificationId: string;
  runId: string;
  jobId: string;
  attemptId: string;
  workflowId: string;
  workflowVersion: number;
  workflowDigest: string;
  sourceRevisionId: string;
  verifierContractDigest: string;
  artifactManifestId: string;
  artifactManifestDigest: string;
  resultDigest: string;
}

export function verificationReceiptDigest(value: VerificationReceiptIdentity): string {
  return canonicalDigest({ schemaVersion: 1, ...value });
}

export function receiptIdentity(
  verification: VerificationState,
  artifactManifestId: string,
  artifactDigest: string,
  resultDigest: string
): VerificationReceiptIdentity {
  return {
    verificationId: verification.verificationId,
    runId: verification.runId,
    jobId: verification.jobId,
    attemptId: verification.attemptId,
    workflowId: verification.workflowId,
    workflowVersion: verification.workflowVersion,
    workflowDigest: verification.workflowDigest,
    sourceRevisionId: verification.sourceRevisionId,
    verifierContractDigest: verification.verifierContractDigest,
    artifactManifestId,
    artifactManifestDigest: artifactDigest,
    resultDigest
  };
}

export function sourceRevisionIdentity(value: SourceRevisionState): SourceRevisionIdentity {
  return {
    repositoryId: value.repositoryId,
    objectFormat: value.objectFormat,
    commitOid: value.commitOid,
    treeOid: value.treeOid
  };
}
