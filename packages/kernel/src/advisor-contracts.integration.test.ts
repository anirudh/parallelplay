import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "./canonical.js";
import { migrateDatabase } from "./database.js";
import { openKernel, type Kernel } from "./sqlite-kernel.js";
import type {
  AdvisorCaseInputV1,
  AdvisorReferenceV1,
  AdvisorSubjectState
} from "./advisor-schema.js";
import type { DecisionPacketRevisionState } from "./schema.js";

const NOW = "2026-08-22T19:00:00.000Z";
const actor = { kind: "operator", id: "advisor-contract-test" } as const;
const system = { kind: "system", id: "advisor-contract-test" } as const;
const clock = { now: () => new Date(NOW) };
const directories: string[] = [];
let sequence = 1;

function id(): string {
  const suffix = String(sequence).padStart(12, "0");
  sequence += 1;
  return `99000000-0000-4000-8000-${suffix}`;
}

function digest(character: string): string {
  return character.repeat(64);
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(label);
  return value;
}

async function execute(kernel: Kernel, command: Parameters<Kernel["execute"]>[0]) {
  const result = await kernel.execute(command);
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message}: ${JSON.stringify(result.error.details)}`
    );
  }
  return result;
}

async function createKernel(): Promise<Kernel> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-advisor-contract-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  await migrateDatabase({ databasePath, clock });
  return openKernel({ databasePath, clock });
}

async function approveSubject(kernel: Kernel): Promise<AdvisorSubjectState> {
  const subjectId = id();
  await execute(kernel, {
    type: "advisor-subject.approve",
    idempotencyKey: `subject:${subjectId}`,
    actor,
    payload: {
      subject: {
        schemaVersion: 1,
        subjectId,
        revision: 1,
        priorSubjectRef: null,
        name: "advisor conformance subject",
        subjectKind: "model",
        driverProtocolVersion: 1,
        adapter: {
          adapterId: "contained-model-adapter",
          adapterDigest: digest("1"),
          image: `parallelplay-advisor@sha256:${digest("2")}`,
          argv: ["/advisor"]
        },
        model: { provider: "fixture-provider", model: "fixture-model", revision: "v1" },
        systemPromptDigest: digest("3"),
        taskPromptDigest: digest("4"),
        responseSchemaVersion: 1,
        inference: { temperature: 0, maxOutputBytes: 65_536, timeoutMs: 10_000 },
        contextCompilerVersion: "advisor-context-v1",
        capabilities: {
          network: false,
          secrets: false,
          git: false,
          database: false,
          source: false,
          artifacts: false
        },
        maxInputBytes: 65_536
      }
    }
  });
  const subject = (await kernel.listAdvisorSubjects())[0];
  if (!subject) throw new Error("Subject was not projected");
  return subject;
}

function fixtureInput(programId: string, optionId: string): AdvisorCaseInputV1 {
  const packetId = id();
  return {
    schemaVersion: 1,
    inputId: id(),
    packetId,
    packetRevisionRef: {
      kind: "decision_packet_revision",
      id: id(),
      digest: digest("5")
    },
    programId,
    milestoneId: null,
    sourceRef: { kind: "operator_decision_request", id: packetId, digest: digest("6") },
    originalQuestion: "Should this bounded decision be recorded?",
    prompt: "Recommend the bounded option or abstain.",
    context: "advisor conformance evidence",
    classification: {
      riskClass: "low",
      safetyClass: "routine",
      reversibility: "reversible",
      sourceKind: "operator_decision_request",
      actionKinds: ["approve"],
      targetKinds: ["record_only"],
      promotionEligible: true,
      exclusionReasons: []
    },
    options: [
      {
        optionId,
        label: "Record the bounded approval",
        consequences: ["Only immutable decision evidence is recorded"],
        reversalCost: "None",
        actionKind: "approve",
        targetKind: "record_only",
        targetParameters: { kind: "record_only" },
        targetPreconditionDigest: digest("7")
      }
    ],
    policyRefs: [],
    precedentRefs: [],
    evidenceRefs: [],
    compiledAt: NOW
  };
}

async function recordCase(
  kernel: Kernel,
  input: AdvisorCaseInputV1,
  provenance: "fixture" | "natural",
  sourceFamily: string,
  adversarial: boolean,
  actionResultRef: AdvisorReferenceV1 | null = null
): Promise<AdvisorReferenceV1> {
  const caseId = id();
  await execute(kernel, {
    type: "advisor-case.record",
    idempotencyKey: `case:${caseId}`,
    actor,
    payload: {
      case: {
        schemaVersion: 1,
        caseId,
        input,
        inputDigest: canonicalDigest(input),
        provenance,
        sourceFamily,
        adversarialCategories: adversarial ? ["boundary-probe"] : [],
        label: {
          selectedOptionId: required(input.options[0], "Advisor case option missing").optionId,
          actionResultRef,
          labeledBy: actor.id,
          labeledAt: NOW
        }
      }
    }
  });
  const stored = (await kernel.listAdvisorCases()).find((entry) => entry.case.caseId === caseId);
  if (!stored) throw new Error("Advisor case was not projected");
  return { kind: "advisor_case", id: caseId, digest: stored.caseDigest };
}

async function recommendCase(
  kernel: Kernel,
  subject: AdvisorSubjectState,
  caseRef: AdvisorReferenceV1,
  purpose: "calibration" | "holdout" | "shadow" | "promoted"
): Promise<string> {
  const invocationId = id();
  const ownerId = id();
  const recommendationId = id();
  await execute(kernel, {
    type: "advisor-invocation.queue",
    idempotencyKey: `queue:${invocationId}`,
    actor: system,
    payload: {
      schemaVersion: 1,
      invocationId,
      subjectId: subject.subject.subjectId,
      purpose,
      caseId: caseRef.id,
      packetId: null,
      packetRevisionId: null,
      packetRevisionDigest: null
    }
  });
  await execute(kernel, {
    type: "advisor-invocation.lease.acquire",
    idempotencyKey: `lease:${invocationId}`,
    actor: system,
    payload: { schemaVersion: 1, invocationId, ownerId, leaseDurationMs: 60_000 }
  });
  const invocation = (await kernel.listAdvisorInvocations()).find(
    (entry) => entry.invocation.invocationId === invocationId
  );
  if (!invocation) throw new Error("Invocation was not projected");
  const optionId = required(
    invocation.invocation.input.options[0],
    "Invocation option missing"
  ).optionId;
  const output = {
    kind: "recommend" as const,
    optionId,
    summary: "The exact bounded option matches the locked policy.",
    policyCitations: [],
    precedentCitations: [],
    evidenceCitations: []
  };
  await execute(kernel, {
    type: "advisor-invocation.complete",
    idempotencyKey: `complete:${invocationId}`,
    actor: system,
    payload: {
      schemaVersion: 1,
      invocationId,
      recommendationId,
      ownerId,
      fencingToken: 1,
      output,
      driverReceipt: {
        schemaVersion: 1,
        subjectRef: {
          kind: "advisor_subject",
          id: subject.subject.subjectId,
          digest: subject.subjectDigest
        },
        inputDigest: invocation.invocation.inputDigest,
        outputDigest: canonicalDigest(output),
        exitCode: 0,
        startedAt: NOW,
        completedAt: NOW,
        usage: { status: "unavailable", reason: "Conformance fixture" }
      }
    }
  });
  return recommendationId;
}

async function naturalCase(
  kernel: Kernel,
  subject: AdvisorSubjectState,
  programId: string,
  index: number,
  recordTargetRef: AdvisorReferenceV1
): Promise<AdvisorReferenceV1> {
  const requestId = id();
  const optionId = id();
  const request = await execute(kernel, {
    type: "decision.request",
    idempotencyKey: `natural-request:${String(index)}`,
    actor,
    payload: {
      request: {
        schemaVersion: 1,
        requestId,
        programId,
        milestoneId: null,
        originalQuestion: `Record bounded natural decision ${String(index)}?`,
        prompt: "Review the record-only decision.",
        context: "Recent production-shadow evidence",
        riskClass: "low",
        safetyClass: "routine",
        reversibility: "reversible",
        options: [
          {
            optionId,
            label: "Record approval",
            consequences: ["Records evidence only"],
            reversalCost: "None",
            action: {
              kind: "approve",
              target: {
                kind: "record_only",
                targetRef: recordTargetRef,
                text: "Record the bounded decision"
              }
            }
          }
        ],
        refs: [],
        deadlineAt: null
      }
    }
  });
  if (request.data.kind !== "decision_packet") throw new Error("Decision packet was not returned");
  const packetId = request.data.packetId;
  const revision = (await kernel.listDecisionPacketRevisions(packetId))[0];
  if (revision?.revision.schemaVersion !== 1) throw new Error("Decision revision missing");
  const option = required(revision.revision.options[0], "Decision option missing");
  await execute(kernel, {
    type: "decision.approve",
    idempotencyKey: `natural-approve:${String(index)}`,
    actor,
    payload: {
      schemaVersion: 1,
      packetId,
      packetRevisionId: revision.revision.packetRevisionId,
      packetRevisionDigest: revision.revisionDigest,
      optionId,
      targetPreconditionDigest: canonicalDigest(option.action.target)
    }
  });
  const actionResult = required(
    (await kernel.listDecisionActionResults(programId)).find(
      (entry) => entry.result.packetRevisionId === revision.revision.packetRevisionId
    ),
    "Natural action result missing"
  );
  const compilerInvocationId = id();
  await execute(kernel, {
    type: "advisor-invocation.queue",
    idempotencyKey: `compile-natural:${String(index)}`,
    actor: system,
    payload: {
      schemaVersion: 1,
      invocationId: compilerInvocationId,
      subjectId: subject.subject.subjectId,
      purpose: "shadow",
      caseId: null,
      packetId,
      packetRevisionId: revision.revision.packetRevisionId,
      packetRevisionDigest: revision.revisionDigest
    }
  });
  const compiled = (await kernel.listAdvisorInvocations()).find(
    (entry) => entry.invocation.invocationId === compilerInvocationId
  );
  if (!compiled) throw new Error("Natural input was not compiled");
  return recordCase(kernel, compiled.invocation.input, "natural", "holdout-natural", index < 25, {
    kind: "decision_action_result",
    id: actionResult.result.actionResultId,
    digest: actionResult.resultDigest
  });
}

async function openRecordOnlyDecision(
  kernel: Kernel,
  programId: string,
  label: string,
  recordTargetRef: AdvisorReferenceV1
): Promise<DecisionPacketRevisionState> {
  const requestId = id();
  const optionId = id();
  const result = await execute(kernel, {
    type: "decision.request",
    idempotencyKey: `promoted-request:${label}`,
    actor,
    payload: {
      request: {
        schemaVersion: 1,
        requestId,
        programId,
        milestoneId: null,
        originalQuestion: "May the bounded policy record this approval?",
        prompt: "Apply only the exact promoted record-only policy.",
        context: "Live promoted-policy conformance decision",
        riskClass: "low",
        safetyClass: "routine",
        reversibility: "reversible",
        options: [
          {
            optionId,
            label: "Record approval",
            consequences: ["Records immutable evidence only"],
            reversalCost: "None",
            action: {
              kind: "approve",
              target: {
                kind: "record_only",
                targetRef: recordTargetRef,
                text: "Record the promoted-policy decision"
              }
            }
          }
        ],
        refs: [],
        deadlineAt: null
      }
    }
  });
  if (result.data.kind !== "decision_packet") throw new Error("Promoted decision packet missing");
  const revision = (await kernel.listDecisionPacketRevisions(result.data.packetId))[0];
  if (!revision) throw new Error("Promoted decision revision missing");
  return revision;
}

afterEach(() => {
  sequence = 1;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("advisor advisor authority contracts", () => {
  it("records proposal supersession and dismissal without creating policy authority", async () => {
    const kernel = await createKernel();
    try {
      const programIds = [id(), id(), id()];
      for (const [index, programId] of programIds.entries()) {
        await execute(kernel, {
          type: "program.create",
          idempotencyKey: `proposal-program:${String(index)}`,
          actor,
          payload: { programId, name: `Proposal program ${String(index + 1)}` }
        });
      }
      const recordTargetRefs: AdvisorReferenceV1[] = [];
      for (const [index, programId] of programIds.entries()) {
        const bootstrapRequestId = id();
        await execute(kernel, {
          type: "decision.request",
          idempotencyKey: `proposal-bootstrap-request:${String(index)}`,
          actor,
          payload: {
            request: {
              schemaVersion: 1,
              requestId: bootstrapRequestId,
              programId,
              milestoneId: null,
              originalQuestion: "Retain this proposal fixture?",
              prompt: "Review the bounded fixture.",
              context: "Stable record-only target for proposal evidence",
              riskClass: "low",
              safetyClass: "routine",
              reversibility: "reversible",
              options: [
                {
                  optionId: id(),
                  label: "Retain fixture",
                  consequences: ["Keeps the fixture at routine priority"],
                  reversalCost: "Low",
                  action: {
                    kind: "reprioritize",
                    target: {
                      kind: "program_attention_priority",
                      programId,
                      expectedProgramVersion: 1,
                      priority: "p1"
                    }
                  }
                }
              ],
              refs: [],
              deadlineAt: null
            }
          }
        });
        const bootstrap = required(
          (await kernel.listOperatorDecisionRequests()).find(
            (entry) => entry.request.requestId === bootstrapRequestId
          ),
          "Proposal bootstrap request missing"
        );
        recordTargetRefs.push({
          kind: "operator_decision_request",
          id: bootstrap.request.requestId,
          digest: bootstrap.requestDigest
        });
      }
      const subject = await approveSubject(kernel);
      const supportingCaseRefs: AdvisorReferenceV1[] = [];
      for (let index = 0; index < 5; index += 1) {
        supportingCaseRefs.push(
          await naturalCase(
            kernel,
            subject,
            required(programIds[index % programIds.length], "Program missing"),
            index,
            required(recordTargetRefs[index % recordTargetRefs.length], "Record target missing")
          )
        );
      }
      const signatureCase = required(
        (await kernel.listAdvisorCases()).find(
          (entry) => entry.case.caseId === supportingCaseRefs[0]?.id
        ),
        "Proposal signature case missing"
      );
      const signatureOption = required(
        signatureCase.case.input.options.find(
          (option) => option.optionId === signatureCase.case.label.selectedOptionId
        ),
        "Proposal signature option missing"
      );
      const selectedOptionSignature = canonicalDigest({
        sourceKind: signatureCase.case.input.classification.sourceKind,
        riskClass: signatureCase.case.input.classification.riskClass,
        safetyClass: signatureCase.case.input.classification.safetyClass,
        reversibility: signatureCase.case.input.classification.reversibility,
        actionKind: signatureOption.actionKind,
        targetKind: signatureOption.targetKind,
        targetParameters: signatureOption.targetParameters,
        policyKinds: [
          ...new Set(signatureCase.case.input.policyRefs.map((reference) => reference.kind))
        ].sort(),
        evidenceKinds: [
          ...new Set(signatureCase.case.input.evidenceRefs.map((reference) => reference.kind))
        ].sort()
      });
      const matcher = {
        sourceKind: "operator_decision_request",
        riskClass: "low" as const,
        safetyClass: "routine" as const,
        reversibility: "reversible" as const,
        actionKind: "approve" as const,
        targetKind: "record_only" as const,
        allowedPriorities: [],
        requiredPolicyKinds: [],
        requiredEvidenceKinds: []
      };
      const proposalIds = [id(), id()];
      for (const proposalId of proposalIds) {
        await execute(kernel, {
          type: "decision-policy-proposal.compile",
          idempotencyKey: `compile-proposal:${proposalId}`,
          actor: system,
          payload: {
            proposal: {
              schemaVersion: 1,
              proposalId,
              matcher,
              selectedOptionSignature,
              supportingCaseRefs,
              conflictingCaseRefs: [],
              supportingProgramIds: [...programIds].sort(),
              rationale: "Repeated bounded record-only decisions",
              examples: [],
              exceptions: [],
              draftedBy: "system",
              subjectRef: null,
              status: "open",
              compiledAt: NOW
            }
          }
        });
      }
      await execute(kernel, {
        type: "decision-policy-proposal.close",
        idempotencyKey: "supersede-proposal",
        actor,
        payload: {
          schemaVersion: 1,
          proposalId: required(proposalIds[0], "Original proposal missing"),
          outcome: "superseded",
          reason: "A clearer immutable proposal replaces this draft",
          replacementProposalId: required(proposalIds[1], "Replacement proposal missing")
        }
      });
      await execute(kernel, {
        type: "decision-policy-proposal.close",
        idempotencyKey: "dismiss-proposal",
        actor,
        payload: {
          schemaVersion: 1,
          proposalId: required(proposalIds[1], "Replacement proposal missing"),
          outcome: "dismissed",
          reason: "Operator declines to create policy authority",
          replacementProposalId: null
        }
      });
      expect(await kernel.listDecisionPolicyProposals()).toMatchObject([
        { status: "superseded", replacementProposalRef: { id: proposalIds[1] } },
        { status: "dismissed", replacementProposalRef: null }
      ]);
      expect(await kernel.listDecisionPolicies()).toEqual([]);
      const beforeRejectedRetry = (await kernel.getAdvisorSnapshot()).throughPosition;
      const rejectedRetry = await kernel.execute({
        type: "decision-policy-proposal.close",
        idempotencyKey: "dismiss-proposal-again",
        actor,
        payload: {
          schemaVersion: 1,
          proposalId: required(proposalIds[1], "Replacement proposal missing"),
          outcome: "dismissed",
          reason: "Duplicate stale dismissal",
          replacementProposalId: null
        }
      });
      expect(rejectedRetry).toMatchObject({
        ok: false,
        error: { code: "DECISION_POLICY_CONFLICT" }
      });
      expect((await kernel.getAdvisorSnapshot()).throughPosition).toBe(beforeRejectedRetry);
    } finally {
      await kernel.close();
    }
  });

  it("earns bounded authority through evidence and suspends it on a serious audit", async () => {
    const kernel = await createKernel();
    try {
      const programId = id();
      await execute(kernel, {
        type: "program.create",
        idempotencyKey: "advisor-program",
        actor,
        payload: { programId, name: "advisor advisor trial" }
      });
      const bootstrapRequestId = id();
      await execute(kernel, {
        type: "decision.request",
        idempotencyKey: "advisor-bootstrap-request",
        actor,
        payload: {
          request: {
            schemaVersion: 1,
            requestId: bootstrapRequestId,
            programId,
            milestoneId: null,
            originalQuestion: "Keep this trial at routine priority?",
            prompt: "Review the bounded priority fixture.",
            context: "Stable source material for record-only conformance decisions",
            riskClass: "low",
            safetyClass: "routine",
            reversibility: "reversible",
            options: [
              {
                optionId: id(),
                label: "Use routine priority",
                consequences: ["The trial remains outside urgent attention"],
                reversalCost: "Low",
                action: {
                  kind: "reprioritize",
                  target: {
                    kind: "program_attention_priority",
                    programId,
                    expectedProgramVersion: 1,
                    priority: "p1"
                  }
                }
              }
            ],
            refs: [],
            deadlineAt: null
          }
        }
      });
      const bootstrap = (await kernel.listOperatorDecisionRequests()).find(
        (entry) => entry.request.requestId === bootstrapRequestId
      );
      if (!bootstrap) throw new Error("Bootstrap request was not projected");
      const recordTargetRef: AdvisorReferenceV1 = {
        kind: "operator_decision_request",
        id: bootstrap.request.requestId,
        digest: bootstrap.requestDigest
      };
      const subject = await approveSubject(kernel);
      const calibrationRefs: AdvisorReferenceV1[] = [];
      const holdoutRefs: AdvisorReferenceV1[] = [];
      const recentRefs: AdvisorReferenceV1[] = [];

      for (let index = 0; index < 50; index += 1) {
        const optionId = id();
        const reference = await recordCase(
          kernel,
          fixtureInput(programId, optionId),
          "fixture",
          "calibration-fixture",
          false
        );
        calibrationRefs.push(reference);
        await recommendCase(kernel, subject, reference, "calibration");
      }
      for (let index = 0; index < 50; index += 1) {
        const reference = await naturalCase(kernel, subject, programId, index, recordTargetRef);
        holdoutRefs.push(reference);
        recentRefs.push(reference);
        await recommendCase(kernel, subject, reference, "holdout");
      }
      for (let index = 0; index < 50; index += 1) {
        const optionId = id();
        const reference = await recordCase(
          kernel,
          fixtureInput(programId, optionId),
          "fixture",
          "holdout-fixture",
          index < 25
        );
        holdoutRefs.push(reference);
        await recommendCase(kernel, subject, reference, "holdout");
      }

      const corpusId = id();
      const corpusRevisionId = id();
      await execute(kernel, {
        type: "advisor-corpus.approve",
        idempotencyKey: "approve-corpus",
        actor,
        payload: {
          corpus: {
            schemaVersion: 1,
            corpusId,
            corpusRevisionId,
            revision: 1,
            priorCorpusRef: null,
            calibrationCaseRefs: calibrationRefs,
            holdoutCaseRefs: holdoutRefs,
            adversarialCategoryRequirements: ["boundary-probe"]
          }
        }
      });
      const corpus = required((await kernel.listAdvisorCorpora())[0], "Corpus missing");
      const policyId = id();
      const policyRevisionId = id();
      await execute(kernel, {
        type: "decision-policy.approve",
        idempotencyKey: "approve-decision-policy",
        actor,
        payload: {
          policy: {
            schemaVersion: 1,
            policyId,
            policyRevisionId,
            revision: 1,
            priorPolicyRef: null,
            proposalRef: null,
            scope: "Low-risk routine reversible record-only decisions",
            executionScope: "live",
            fixtureProgramIds: [],
            riskClass: "low",
            matcher: {
              sourceKind: "operator_decision_request",
              riskClass: "low",
              safetyClass: "routine",
              reversibility: "reversible",
              actionKind: "approve",
              targetKind: "record_only",
              allowedPriorities: [],
              requiredPolicyKinds: [],
              requiredEvidenceKinds: []
            },
            rule: "Approve only record-only options under the exact source classification.",
            rationale: "The bounded action has no external side effect.",
            examples: ["Record a routine approval"],
            exceptions: ["Abstain on ambiguity"],
            owner: actor.id,
            subjectRef: {
              kind: "advisor_subject",
              id: subject.subject.subjectId,
              digest: subject.subjectDigest
            },
            corpusRevisionRef: {
              kind: "advisor_corpus",
              id: corpus.corpus.corpusRevisionId,
              digest: corpus.corpusDigest
            },
            auditRate: 0.2,
            expiresAt: "2026-10-01T19:00:00.000Z"
          }
        }
      });

      const inactive = await kernel.execute({
        type: "advisor.resolve",
        idempotencyKey: "cannot-resolve-before-promotion",
        actor: system,
        payload: {
          schemaVersion: 1,
          resolutionId: id(),
          recommendationId: required(
            (await kernel.listAdvisorRecommendations())[0],
            "Recommendation missing"
          ).recommendation.recommendationId,
          policyRevisionId,
          packetId: id(),
          packetRevisionId: id(),
          packetRevisionDigest: digest("9"),
          optionId: id(),
          targetPreconditionDigest: digest("a")
        }
      });
      expect(inactive).toMatchObject({ ok: false, error: { code: "DECISION_POLICY_INACTIVE" } });

      let reportId = id();
      const beforeEvaluation = await kernel.getAdvisorSnapshot();
      await execute(kernel, {
        type: "advisor-evaluation.compile",
        idempotencyKey: "compile-evaluation",
        actor: system,
        payload: {
          schemaVersion: 1,
          reportId,
          subjectId: subject.subject.subjectId,
          policyRevisionId,
          corpusRevisionId,
          recentCaseIds: recentRefs.map((reference) => reference.id),
          expectedThroughPosition: beforeEvaluation.throughPosition
        }
      });
      const evaluation = required(
        (await kernel.listAdvisorEvaluations(policyRevisionId))[0],
        "Evaluation missing"
      );
      expect(evaluation.report).toMatchObject({
        calibrationCount: 50,
        promotionEligible: true,
        holdout: {
          eligibleCount: 100,
          recommendedCount: 100,
          agreementCount: 100,
          adversarialCount: 50,
          coverage: 1
        },
        recentShadow: { eligibleCount: 50, agreementCount: 50, coverage: 1 },
        contaminationCount: 0,
        blockers: []
      });
      expect(evaluation.report.holdout.wilsonLowerBound).toBeGreaterThanOrEqual(0.95);

      const lateMatchingCase = await recordCase(
        kernel,
        fixtureInput(programId, id()),
        "fixture",
        "post-evaluation-fixture",
        false
      );
      const stalePromotion = await kernel.execute({
        type: "advisor-promotion.compile",
        idempotencyKey: "reject-stale-promotion",
        actor: system,
        payload: {
          schemaVersion: 1,
          packetId: id(),
          packetRevisionId: id(),
          evidenceBundleId: id(),
          policyRevisionId,
          evaluationReportId: reportId,
          expectedThroughPosition: (await kernel.getAdvisorSnapshot()).throughPosition
        }
      });
      expect(stalePromotion).toMatchObject({
        ok: false,
        error: { code: "DECISION_POLICY_NOT_PROMOTABLE" }
      });

      await recommendCase(kernel, subject, lateMatchingCase, "holdout");
      reportId = id();
      await execute(kernel, {
        type: "advisor-evaluation.compile",
        idempotencyKey: "refresh-evaluation",
        actor: system,
        payload: {
          schemaVersion: 1,
          reportId,
          subjectId: subject.subject.subjectId,
          policyRevisionId,
          corpusRevisionId,
          recentCaseIds: recentRefs.map((reference) => reference.id),
          expectedThroughPosition: (await kernel.getAdvisorSnapshot()).throughPosition
        }
      });

      const promotionPacketId = id();
      const promotionRevisionId = id();
      const evidenceBundleId = id();
      const beforePromotionPacket = await kernel.getAdvisorSnapshot();
      await execute(kernel, {
        type: "advisor-promotion.compile",
        idempotencyKey: "compile-promotion",
        actor: system,
        payload: {
          schemaVersion: 1,
          packetId: promotionPacketId,
          packetRevisionId: promotionRevisionId,
          evidenceBundleId,
          policyRevisionId,
          evaluationReportId: reportId,
          expectedThroughPosition: beforePromotionPacket.throughPosition
        }
      });
      const promotionRevision = required(
        (await kernel.listDecisionPacketRevisions(promotionPacketId))[0],
        "Promotion revision missing"
      );
      if (promotionRevision.revision.schemaVersion !== 3)
        throw new Error("Promotion packet is not V3");
      const promotionOption = required(
        promotionRevision.revision.options[0],
        "Promotion option missing"
      );
      const promotionId = id();
      await execute(kernel, {
        type: "decision.promote-advisor-policy",
        idempotencyKey: "promote-policy",
        actor,
        payload: {
          schemaVersion: 3,
          promotionId,
          packetId: promotionPacketId,
          packetRevisionId: promotionRevisionId,
          packetRevisionDigest: promotionRevision.revisionDigest,
          optionId: promotionOption.optionId,
          targetPreconditionDigest: promotionOption.action.target.preconditionDigest
        }
      });
      expect((await kernel.listDecisionPolicies())[0]).toMatchObject({
        status: "active",
        promotionId,
        automaticResolutionCount: 0
      });

      const liveRevision = await openRecordOnlyDecision(kernel, programId, "one", recordTargetRef);
      if (liveRevision.revision.schemaVersion !== 1) throw new Error("Live revision is not V1");
      const liveInvocationId = id();
      await execute(kernel, {
        type: "advisor-invocation.queue",
        idempotencyKey: "queue-promoted",
        actor: system,
        payload: {
          schemaVersion: 1,
          invocationId: liveInvocationId,
          subjectId: subject.subject.subjectId,
          purpose: "promoted",
          caseId: null,
          packetId: liveRevision.revision.packetId,
          packetRevisionId: liveRevision.revision.packetRevisionId,
          packetRevisionDigest: liveRevision.revisionDigest
        }
      });
      const ownerId = id();
      const recommendationId = id();
      await execute(kernel, {
        type: "advisor-invocation.lease.acquire",
        idempotencyKey: "lease-promoted",
        actor: system,
        payload: {
          schemaVersion: 1,
          invocationId: liveInvocationId,
          ownerId,
          leaseDurationMs: 60_000
        }
      });
      const liveInvocation = required(
        (await kernel.listAdvisorInvocations()).find(
          (entry) => entry.invocation.invocationId === liveInvocationId
        ),
        "Live invocation missing"
      );
      const liveOption = required(liveRevision.revision.options[0], "Live option missing");
      const liveOutput = {
        kind: "recommend" as const,
        optionId: liveOption.optionId,
        summary: "Exact promoted record-only policy match.",
        policyCitations: [],
        precedentCitations: [],
        evidenceCitations: []
      };
      await execute(kernel, {
        type: "advisor-invocation.complete",
        idempotencyKey: "complete-promoted",
        actor: system,
        payload: {
          schemaVersion: 1,
          invocationId: liveInvocationId,
          recommendationId,
          ownerId,
          fencingToken: 1,
          output: liveOutput,
          driverReceipt: {
            schemaVersion: 1,
            subjectRef: {
              kind: "advisor_subject",
              id: subject.subject.subjectId,
              digest: subject.subjectDigest
            },
            inputDigest: liveInvocation.invocation.inputDigest,
            outputDigest: canonicalDigest(liveOutput),
            exitCode: 0,
            startedAt: NOW,
            completedAt: NOW,
            usage: { status: "unavailable", reason: "Conformance fixture" }
          }
        }
      });
      const automaticResolutionId = id();
      await execute(kernel, {
        type: "advisor.resolve",
        idempotencyKey: "resolve-promoted",
        actor: system,
        payload: {
          schemaVersion: 1,
          resolutionId: automaticResolutionId,
          recommendationId,
          policyRevisionId,
          packetId: liveRevision.revision.packetId,
          packetRevisionId: liveRevision.revision.packetRevisionId,
          packetRevisionDigest: liveRevision.revisionDigest,
          optionId: liveOption.optionId,
          targetPreconditionDigest: canonicalDigest(liveOption.action.target)
        }
      });
      expect((await kernel.listAdvisorResolutions(programId))[0]).toMatchObject({
        resolution: {
          resolutionId: automaticResolutionId,
          auditSelected: true,
          actionKind: "approve",
          targetKind: "record_only"
        }
      });
      const actionResult = (await kernel.listDecisionActionResults(programId)).find(
        (entry) => entry.result.packetId === liveRevision.revision.packetId
      );
      expect(actionResult).toMatchObject({
        result: {
          schemaVersion: 3,
          authority: "approved_policy",
          policyRevisionRef: { id: policyRevisionId }
        }
      });
      const audit = required(
        (await kernel.listAdvisorAudits(policyRevisionId))[0],
        "Advisor audit missing"
      );
      expect(audit.audit.status).toBe("pending");
      await execute(kernel, {
        type: "advisor-audit.record",
        idempotencyKey: "serious-audit",
        actor,
        payload: {
          schemaVersion: 1,
          auditId: audit.audit.auditId,
          finding: "serious_disagreement",
          evidenceRefs: [],
          notes: "The advisor recommendation missed material operator context."
        }
      });
      expect((await kernel.listDecisionPolicies())[0]).toMatchObject({ status: "suspended" });
      expect((await kernel.listAdvisorIncidents(policyRevisionId))[0]).toMatchObject({
        incident: { kind: "serious_disagreement", status: "open" }
      });
      const safetyPage = (await kernel.listAttentionQueue(programId, "page")).find(
        (entry) => entry.revision.revision.routing.reason === "advisor_serious_incident"
      );
      expect(safetyPage?.revision.revision).toMatchObject({
        safetyClass: "safety_critical",
        routing: {
          route: "page",
          urgency: "p0",
          routineBudget: { applied: false }
        }
      });
      expect(await kernel.verifyProjections()).toMatchObject({
        valid: true,
        projectionSchemaVersion: 1
      });
    } finally {
      await kernel.close();
    }
  }, 30_000);
});
