import { createHash } from "node:crypto";
import {
  canonicalDigest,
  type Clock,
  type CommandResult,
  type IntegrationCandidateState,
  type IntegrationTargetState,
  type IntegrationWorkState,
  type Kernel,
  type SourceRevisionState
} from "@parallelplay/kernel";
import type { GitRevisionStore } from "./source-store.js";
import type { TrustedCommandVerifier } from "./verifier.js";

const systemClock: Clock = { now: () => new Date() };

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const value = bytes.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export interface IntegrationSupervisorOptions {
  kernel: Kernel;
  sourceStore: GitRevisionStore;
  verifier: TrustedCommandVerifier;
  supervisorId: string;
  clock?: Clock;
  leaseMs?: number;
}

export interface IntegrationTickResult {
  action:
    | "idle"
    | "work_leased"
    | "candidate_prepared"
    | "conflict_recorded"
    | "candidate_verified"
    | "decision_compiled"
    | "candidate_promoted"
    | "command_rejected";
  occurredAt: string;
  supervisorId: string;
  candidateId?: string;
  workId?: string;
  commandResult?: CommandResult;
  error?: string;
}

export interface IntegrationSupervisorRunOptions {
  signal?: AbortSignal;
  maxTicks?: number;
  pollIntervalMs?: number;
}

function commandTick(
  result: CommandResult,
  action: IntegrationTickResult["action"],
  occurredAt: string,
  supervisorId: string,
  detail: Pick<IntegrationTickResult, "candidateId" | "workId"> = {}
): IntegrationTickResult {
  return result.ok
    ? { action, occurredAt, supervisorId, commandResult: result, ...detail }
    : {
        action: "command_rejected",
        occurredAt,
        supervisorId,
        commandResult: result,
        error: `${result.error.code}: ${result.error.message}`,
        ...detail
      };
}

export class IntegrationSupervisor {
  readonly #kernel: Kernel;
  readonly #sourceStore: GitRevisionStore;
  readonly #verifier: TrustedCommandVerifier;
  readonly #supervisorId: string;
  readonly #clock: Clock;
  readonly #leaseMs: number;

  constructor(options: IntegrationSupervisorOptions) {
    this.#kernel = options.kernel;
    this.#sourceStore = options.sourceStore;
    this.#verifier = options.verifier;
    this.#supervisorId = options.supervisorId;
    this.#clock = options.clock ?? systemClock;
    // Keep the effect lease slightly wider than the maximum verifier attempt so
    // verifier teardown and the authoritative receipt can complete while fenced.
    this.#leaseMs = options.leaseMs ?? 310_000;
  }

  async #source(id: string): Promise<SourceRevisionState> {
    const value = await this.#kernel.getState({ kind: "source_revision", id });
    if (value?.kind !== "source_revision") throw new Error(`Source revision ${id} is missing`);
    return value;
  }

  async #candidate(work: IntegrationWorkState): Promise<IntegrationCandidateState> {
    const value = await this.#kernel.getState({
      kind: "integration_candidate",
      id: work.work.candidateId
    });
    if (value?.kind !== "integration_candidate") {
      throw new Error(`Integration candidate ${work.work.candidateId} is missing`);
    }
    return value;
  }

  async #target(candidate: IntegrationCandidateState): Promise<IntegrationTargetState> {
    const value = await this.#kernel.getState({
      kind: "integration_target",
      id: candidate.candidate.targetRef.id
    });
    if (value?.kind !== "integration_target") {
      throw new Error(`Integration target ${candidate.candidate.targetRef.id} is missing`);
    }
    return value;
  }

  async tick(): Promise<IntegrationTickResult> {
    const occurredAt = this.#clock.now().toISOString();
    const pendingProgram = (await this.#kernel.listPrograms()).find(
      (program) => program.programMode === "graph_v2" && program.phase === "integration_pending"
    );
    if (pendingProgram?.activeGraphRevisionId && pendingProgram.activeGraphDigest) {
      const graphState = await this.#kernel.getState({
        kind: "program_graph",
        id: pendingProgram.activeGraphRevisionId
      });
      if (graphState?.kind !== "program_graph" || graphState.graph.schemaVersion !== 2) {
        throw new Error("Integration-pending program Graph V2 is missing");
      }
      const finalOutcome = (await this.#kernel.listOutcomePackets(pendingProgram.programId))
        .filter(
          (packet) =>
            packet.packet.recommendation === "merge" && packet.packet.candidateRevisionId !== null
        )
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
      if (!finalOutcome?.packet.candidateRevisionId) {
        throw new Error("Integration-pending program final outcome is missing");
      }
      const candidateId = deterministicUuid(
        `parallelplay:integration:integration-candidate:${pendingProgram.programId}:${graphState.graphRevisionId}:${finalOutcome.packet.candidateRevisionId}`
      );
      const existingCandidate = await this.#kernel.getState({
        kind: "integration_candidate",
        id: candidateId
      });
      if (!existingCandidate) {
        const original = await this.#source(finalOutcome.packet.candidateRevisionId);
        const base = await this.#source(graphState.graph.initialSourceRef.id);
        const manifestId = deterministicUuid(
          `parallelplay:integration:candidate-diff:${graphState.graphRevisionId}:${original.revisionDigest}`
        );
        const existingManifest = await this.#kernel.getState({
          kind: "candidate_diff_manifest",
          id: manifestId
        });
        if (!existingManifest) {
          const entries = await this.#sourceStore.candidateDiff(base, original);
          const allowedSurfaces = [
            ...new Map(
              graphState.graph.milestones
                .flatMap((milestone) => milestone.workSurfaces)
                .map((surface) => [`${surface.kind}:${surface.path}`, surface])
            ).values()
          ].sort(
            (left, right) =>
              left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
          );
          const violations = entries
            .filter(
              (entry) =>
                !allowedSurfaces.some((surface) =>
                  surface.kind === "file"
                    ? entry.path === surface.path
                    : entry.path === surface.path || entry.path.startsWith(`${surface.path}/`)
                )
            )
            .map((entry) => entry.path)
            .sort();
          const generations = await this.#kernel.listMilestoneGenerations(pendingProgram.programId);
          const finalGeneration = generations.sort((left, right) =>
            right.startedAt.localeCompare(left.startedAt)
          )[0];
          if (!finalGeneration) throw new Error("Final generation is missing");
          const manifest = {
            schemaVersion: 1 as const,
            manifestId,
            programId: pendingProgram.programId,
            graphRevisionId: graphState.graphRevisionId,
            generationId: finalGeneration.generationId,
            baseRevisionRef: graphState.graph.initialSourceRef,
            candidateRevisionRef: {
              kind: "source_revision" as const,
              id: original.revisionId,
              digest: original.revisionDigest
            },
            entries,
            allowedSurfaces,
            violations,
            eligible: violations.length === 0,
            generatedAt: occurredAt
          };
          const result = await this.#kernel.execute({
            type: "candidate-diff.record",
            idempotencyKey: `candidate-diff:${manifestId}`,
            actor: { kind: "system", id: this.#supervisorId },
            payload: { manifest, manifestDigest: canonicalDigest(manifest) }
          });
          return commandTick(result, "candidate_prepared", occurredAt, this.#supervisorId, {
            candidateId
          });
        }
        if (
          existingManifest.kind !== "candidate_diff_manifest" ||
          !existingManifest.manifest.eligible
        ) {
          if (existingManifest.kind !== "candidate_diff_manifest") {
            throw new Error("Candidate diff manifest is missing");
          }
          const issueId = deterministicUuid(
            `parallelplay:integration:surface-violation:${existingManifest.manifest.manifestId}`
          );
          const existingIssue = await this.#kernel.getState({ kind: "routed_issue", id: issueId });
          if (existingIssue) {
            return {
              action: "idle",
              occurredAt,
              supervisorId: this.#supervisorId,
              candidateId,
              error: "Candidate has immutable out-of-surface violations"
            };
          }
          const result = await this.#kernel.execute({
            type: "issue.raise",
            idempotencyKey: `surface-violation:${issueId}`,
            actor: { kind: "system", id: this.#supervisorId },
            payload: {
              schemaVersion: 1,
              issueId,
              programId: existingManifest.manifest.programId,
              originalText: `Candidate changed paths outside approved surfaces: ${existingManifest.manifest.violations.join(", ")}`,
              proposedClass: "authority_boundary",
              resultImpact: "may_change_accepted_result",
              affectedMilestoneIds: [
                graphState.graph.milestones.at(-1)?.contract.milestoneId ??
                  existingManifest.manifest.generationId
              ],
              refs: [existingManifest.manifest.candidateRevisionRef],
              source: { kind: "command" }
            }
          });
          return commandTick(result, "candidate_prepared", occurredAt, this.#supervisorId, {
            candidateId
          });
        }
        const admissions = await this.#kernel.listPortfolioAdmissions(pendingProgram.programId);
        const finalAdmission = admissions
          .filter((entry) => entry.status === "released")
          .sort(
            (left, right) => right.admission.admissionSequence - left.admission.admissionSequence
          )[0];
        if (!finalAdmission) throw new Error("Final admission evidence is missing");
        const allCandidates = await this.#kernel.listIntegrationCandidates();
        const dependencyCandidateIds = graphState.graph.crossProgramDependencies.flatMap(
          (dependency) => {
            const found = allCandidates.find(
              (entry) =>
                entry.candidate.programId === dependency.programId &&
                entry.candidate.graphRevisionRef.id === dependency.graphRevisionId &&
                entry.candidate.graphRevisionRef.digest === dependency.graphDigest
            );
            return found ? [found.candidate.candidateId] : [];
          }
        );
        const currentPaths = new Set(existingManifest.manifest.entries.map((entry) => entry.path));
        const priorManifests = await this.#kernel.listCandidateDiffManifests();
        const actualOverlapPredecessorIds = allCandidates
          .filter(
            (entry) =>
              entry.candidate.targetRef.id ===
                ("integrationTargetRef" in graphState.graph
                  ? graphState.graph.integrationTargetRef.id
                  : "") &&
              entry.candidate.finalAdmissionSequence < finalAdmission.admission.admissionSequence
          )
          .filter((entry) => {
            const manifest = priorManifests.find(
              (candidateManifest) =>
                candidateManifest.manifest.manifestId === entry.candidate.diffManifestRef.id
            );
            return manifest?.manifest.entries.some((path) => currentPaths.has(path.path)) ?? false;
          })
          .map((entry) => entry.candidate.candidateId)
          .sort();
        const candidate = {
          schemaVersion: 1 as const,
          candidateId,
          programId: pendingProgram.programId,
          graphRevisionRef: {
            kind: "program_graph" as const,
            id: graphState.graphRevisionId,
            digest: graphState.graphDigest
          },
          policyRef: graphState.graph.portfolioPolicyRef,
          targetRef: graphState.graph.integrationTargetRef,
          originalCandidateRef: existingManifest.manifest.candidateRevisionRef,
          diffManifestRef: {
            kind: "candidate_diff_manifest" as const,
            id: existingManifest.manifest.manifestId,
            digest: existingManifest.manifestDigest
          },
          finalAdmissionSequence: finalAdmission.admission.admissionSequence,
          dependencyCandidateIds,
          actualOverlapPredecessorIds,
          queuedAt: occurredAt
        };
        const workId = deterministicUuid(`${candidateId}:integration-work`);
        const result = await this.#kernel.execute({
          type: "integration-candidate.queue",
          idempotencyKey: `integration-candidate:${candidateId}`,
          actor: { kind: "system", id: this.#supervisorId },
          payload: { candidate, candidateDigest: canonicalDigest(candidate), workId }
        });
        return commandTick(result, "candidate_prepared", occurredAt, this.#supervisorId, {
          candidateId,
          workId
        });
      }
    }
    const workItems = await this.#kernel.listIntegrationWork();
    const pending =
      workItems.find(
        (entry) =>
          entry.work.status === "leased" &&
          (entry.work.leaseExpiresAt === null || entry.work.leaseExpiresAt <= occurredAt)
      ) ?? workItems.find((entry) => entry.work.status === "pending");
    if (pending) {
      const candidate = await this.#candidate(pending);
      const result = await this.#kernel.execute({
        type: "integration-work.lease.acquire",
        idempotencyKey: `integration-lease:${pending.work.workId}:${String(pending.work.leaseFencingToken + 1)}`,
        actor: { kind: "system", id: this.#supervisorId },
        payload: {
          schemaVersion: 1,
          workId: pending.work.workId,
          ownerId: this.#supervisorId,
          leaseDurationMs: this.#leaseMs
        }
      });
      return commandTick(result, "work_leased", occurredAt, this.#supervisorId, {
        candidateId: candidate.candidate.candidateId,
        workId: pending.work.workId
      });
    }

    const leased = workItems.find(
      (entry) =>
        entry.work.status === "leased" &&
        entry.work.leaseOwnerId === this.#supervisorId &&
        entry.work.leaseExpiresAt !== null &&
        entry.work.leaseExpiresAt > occurredAt
    );
    if (leased) {
      const candidate = await this.#candidate(leased);
      const target = await this.#target(candidate);
      const manifest = await this.#kernel.getState({
        kind: "candidate_diff_manifest",
        id: candidate.candidate.diffManifestRef.id
      });
      if (manifest?.kind !== "candidate_diff_manifest") {
        throw new Error("Candidate diff manifest is missing");
      }
      const base = await this.#source(manifest.manifest.baseRevisionRef.id);
      const original = await this.#source(candidate.candidate.originalCandidateRef.id);
      const expectedHead = await this.#source(target.currentHeadRef.id);
      const revisionId = deterministicUuid(
        `parallelplay:integration:rebased:${candidate.candidate.candidateId}:${target.currentHeadRef.digest}`
      );
      const prepared = await this.#sourceStore.prepareIntegrationRevision({
        targetId: target.target.targetId,
        revisionId,
        captureKey: `integration:${candidate.candidate.candidateId}:${target.currentHeadRef.digest}`,
        baseRevision: base,
        candidateRevision: original,
        expectedHeadRevision: expectedHead,
        candidateId: candidate.candidate.candidateId,
        preparedAt: occurredAt
      });
      if (prepared.outcome === "conflicted") {
        const conflictId = deterministicUuid(
          `parallelplay:integration:conflict:${candidate.candidate.candidateId}:${target.currentHeadRef.digest}`
        );
        const conflict = {
          schemaVersion: 1 as const,
          conflictId,
          candidateId: candidate.candidate.candidateId,
          expectedHeadRef: target.currentHeadRef,
          originalCandidateRef: candidate.candidate.originalCandidateRef,
          mergeBaseOid: prepared.mergeBaseOid,
          paths: prepared.paths,
          recordedAt: occurredAt
        };
        const result = await this.#kernel.execute({
          type: "integration-work.conflict",
          idempotencyKey: `integration-conflict:${conflictId}`,
          actor: { kind: "system", id: this.#supervisorId },
          payload: {
            schemaVersion: 1,
            workId: leased.work.workId,
            ownerId: this.#supervisorId,
            fencingToken: leased.work.leaseFencingToken,
            conflict,
            conflictDigest: canonicalDigest(conflict)
          }
        });
        return commandTick(result, "conflict_recorded", occurredAt, this.#supervisorId, {
          candidateId: candidate.candidate.candidateId,
          workId: leased.work.workId
        });
      }
      const existingRebased = await this.#kernel.getState({
        kind: "source_revision",
        id: prepared.revision.revisionId
      });
      let rebased: SourceRevisionState | null =
        existingRebased?.kind === "source_revision" ? existingRebased : null;
      if (!rebased) {
        const registered = await this.#kernel.execute({
          type: "source-revision.register",
          idempotencyKey: `integration-revision:${prepared.revision.revisionId}`,
          actor: { kind: "system", id: this.#supervisorId },
          payload: prepared.revision
        });
        if (!registered.ok) {
          return commandTick(registered, "candidate_prepared", occurredAt, this.#supervisorId, {
            candidateId: candidate.candidate.candidateId,
            workId: leased.work.workId
          });
        }
        if (registered.data.kind !== "source_revision") {
          throw new Error("Prepared revision registration returned another state kind");
        }
        rebased = registered.data;
      }
      const result = await this.#kernel.execute({
        type: "integration-work.prepare",
        idempotencyKey: `integration-prepared:${leased.work.workId}:${target.currentHeadRef.digest}`,
        actor: { kind: "system", id: this.#supervisorId },
        payload: {
          schemaVersion: 1,
          workId: leased.work.workId,
          ownerId: this.#supervisorId,
          fencingToken: leased.work.leaseFencingToken,
          expectedHeadRef: target.currentHeadRef,
          rebasedCandidateRef: {
            kind: "source_revision",
            id: rebased.revisionId,
            digest: rebased.revisionDigest
          }
        }
      });
      return commandTick(result, "candidate_prepared", occurredAt, this.#supervisorId, {
        candidateId: candidate.candidate.candidateId,
        workId: leased.work.workId
      });
    }

    const prepared = workItems.find((entry) => entry.work.status === "prepared");
    if (prepared?.work.expectedHeadRef && prepared.work.rebasedCandidateRef) {
      const candidate = await this.#candidate(prepared);
      const target = await this.#target(candidate);
      const source = await this.#source(prepared.work.rebasedCandidateRef.id);
      const verificationId = deterministicUuid(
        `parallelplay:integration:integration-verification:${candidate.candidate.candidateId}:${prepared.work.expectedHeadRef.digest}:${prepared.work.rebasedCandidateRef.digest}`
      );
      const attemptId = deterministicUuid(`${verificationId}:attempt`);
      const verified = await this.#verifier.verify({
        verificationId,
        attemptId,
        sourceRevision: source,
        verifierContract: target.target.verifierContract,
        verifierContractDigest: target.target.verifierContractDigest,
        remainingAttemptMs: target.target.verifierContract.timeoutMs + 1_000
      });
      const verification = {
        schemaVersion: 1 as const,
        integrationVerificationId: verificationId,
        candidateId: candidate.candidate.candidateId,
        expectedHeadRef: prepared.work.expectedHeadRef,
        rebasedCandidateRef: prepared.work.rebasedCandidateRef,
        verifierContractDigest: target.target.verifierContractDigest,
        result: verified.result.outcome === "passed" ? ("passed" as const) : ("failed" as const),
        exitCode: verified.result.exitCode,
        failureReason: verified.result.failureReason,
        resultDigest: verified.resultDigest,
        receiptDigest: canonicalDigest({
          verificationId,
          attemptId,
          sourceRevisionDigest: source.revisionDigest,
          verifierContractDigest: target.target.verifierContractDigest,
          resultDigest: verified.resultDigest
        }),
        completedAt: occurredAt
      };
      const result = await this.#kernel.execute({
        type: "integration-work.verify",
        idempotencyKey: `integration-verified:${verificationId}`,
        actor: { kind: "system", id: this.#supervisorId },
        payload: {
          schemaVersion: 1,
          workId: prepared.work.workId,
          ownerId: this.#supervisorId,
          fencingToken: prepared.work.leaseFencingToken,
          verification,
          verificationDigest: canonicalDigest(verification)
        }
      });
      return commandTick(result, "candidate_verified", occurredAt, this.#supervisorId, {
        candidateId: candidate.candidate.candidateId,
        workId: prepared.work.workId
      });
    }

    const awaiting = (await this.#kernel.listIntegrationCandidates()).find(
      (entry) => entry.status === "awaiting_authorization"
    );
    if (awaiting) {
      const result = await this.#kernel.compileIntegrationDecision(awaiting.candidate.candidateId);
      if (result) {
        return commandTick(result, "decision_compiled", occurredAt, this.#supervisorId, {
          candidateId: awaiting.candidate.candidateId
        });
      }
    }

    const authorized = workItems.find((entry) => entry.work.status === "authorized");
    if (authorized?.work.expectedHeadRef && authorized.work.rebasedCandidateRef) {
      const candidate = await this.#candidate(authorized);
      const target = await this.#target(candidate);
      const expected = await this.#source(authorized.work.expectedHeadRef.id);
      const rebased = await this.#source(authorized.work.rebasedCandidateRef.id);
      await this.#sourceStore.promoteIntegrationRef({
        targetId: target.target.targetId,
        repositoryId: target.target.repositoryId,
        expectedOldCommitOid: expected.commitOid,
        newCommitOid: rebased.commitOid
      });
      if (!authorized.work.authorizationRef) throw new Error("Promotion authority is missing");
      const receiptId = deterministicUuid(
        `parallelplay:integration:promotion:${candidate.candidate.candidateId}:${authorized.work.authorizationRef.digest}`
      );
      const receipt = {
        schemaVersion: 1 as const,
        receiptId,
        candidateId: candidate.candidate.candidateId,
        programId: candidate.candidate.programId,
        targetRef: candidate.candidate.targetRef,
        managedRef: target.target.managedRef,
        expectedOldHeadRef: authorized.work.expectedHeadRef,
        newHeadRef: authorized.work.rebasedCandidateRef,
        authorizationRef: authorized.work.authorizationRef,
        refEffectKey: canonicalDigest({
          managedRef: target.target.managedRef,
          expected: authorized.work.expectedHeadRef,
          next: authorized.work.rebasedCandidateRef,
          authorization: authorized.work.authorizationRef
        }),
        promotedBy: this.#supervisorId,
        promotedAt: occurredAt
      };
      const result = await this.#kernel.execute({
        type: "integration.promote.record",
        idempotencyKey: `integration-promotion:${receiptId}`,
        actor: { kind: "system", id: this.#supervisorId },
        payload: { receipt, receiptDigest: canonicalDigest(receipt) }
      });
      return commandTick(result, "candidate_promoted", occurredAt, this.#supervisorId, {
        candidateId: candidate.candidate.candidateId,
        workId: authorized.work.workId
      });
    }

    return { action: "idle", occurredAt, supervisorId: this.#supervisorId };
  }

  async run(options: IntegrationSupervisorRunOptions = {}): Promise<number> {
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    let ticks = 0;
    while (
      !options.signal?.aborted &&
      (options.maxTicks === undefined || ticks < options.maxTicks)
    ) {
      await this.tick();
      ticks += 1;
      if (
        !options.signal?.aborted &&
        (options.maxTicks === undefined || ticks < options.maxTicks)
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
    return ticks;
  }
}
