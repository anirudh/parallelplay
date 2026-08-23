interface CriterionResult {
  criterionId: string;
  statement: string;
  result: "pass" | "fail" | "unverified";
}

interface AttemptSummary {
  attemptId: string;
  ordinal: number;
  status: string;
  terminationReason: string | null;
  cumulativeUsage: { cpuMillis: number; memoryPeakBytes: number } | null;
}

interface MilestoneSnapshot {
  program: {
    name: string;
    intent: { objective: string; nonGoals: string[]; tenets: string[]; riskClass: string } | null;
  };
  milestone: {
    milestoneId: string;
    status: string;
    contract: {
      title: string;
      objective: string;
      criteria: { criterionId: string; statement: string }[];
    };
  };
  run: { runId: string; status: string } | null;
  job: { candidateRevisionId: string | null } | null;
  attempts: AttemptSummary[];
  verifications: { verificationId: string; status: string; failureReason: string | null }[];
  driverReceipts: {
    driverReceiptId: string;
    outcome: string;
    receipt: { usage: { cpuMillis: number; memoryPeakBytes: number } };
  }[];
  outcomePacket: {
    outcomePacketId: string;
    packet: {
      recommendation: string;
      summary: string;
      criteriaResults: CriterionResult[];
    };
  } | null;
}

interface ExplorerSnapshot {
  generatedAt: string;
  milestones: MilestoneSnapshot[];
  portfolio: PortfolioSnapshot;
  advisor: AdvisorSnapshot;
}

interface AdvisorSnapshot {
  throughPosition: number;
  subjects: { subject: { subjectId: string; name: string; revision: number } }[];
  corpora: {
    corpus: {
      corpusRevisionId: string;
      calibrationCaseRefs: unknown[];
      holdoutCaseRefs: unknown[];
    };
  }[];
  evaluations: {
    report: {
      reportId: string;
      promotionEligible: boolean;
      blockers: string[];
      holdout: { coverage: number; wilsonLowerBound: number; seriousDisagreementCount: number };
    };
  }[];
  policies: {
    status: string;
    automaticResolutionCount: number;
    policy: { policyRevisionId: string; owner: string; expiresAt: string };
  }[];
  promotions: {
    promotion: { promotionId: string; policyRevisionRef: { id: string }; expiresAt: string };
  }[];
  resolutions: {
    resolution: { resolutionId: string; policyRevisionRef: { id: string }; auditSelected: boolean };
  }[];
  audits: { audit: { auditId: string; status: string; finding: string | null; dueAt: string } }[];
  incidents: { incident: { incidentId: string; kind: string; status: string; detail: string } }[];
  blockers: { policyRevisionId: string; reasons: string[] }[];
}

interface PortfolioSnapshot {
  throughPosition: number;
  admissionFrozen: boolean;
  programs: {
    programId: string;
    name: string;
    phase: string | null;
    executionRequestedAt: string | null;
  }[];
  eligibilityBlockers: { programId: string; blockers: string[] }[];
  activeClaims: {
    lease: {
      claimKind: string;
      claimKey: string;
      programId: string;
      expiresAt: string;
      fencingToken: number;
    };
  }[];
  leaseRecovery: { lease: { claimKey: string; programId: string; expiresAt: string } }[];
  integrationOrder: {
    status: string;
    candidate: {
      candidateId: string;
      programId: string;
      finalAdmissionSequence: number;
      queuedAt: string;
    };
  }[];
  integrationWork: { work: { workId: string; candidateId: string; status: string } }[];
  conflicts: { conflict: { candidateId: string; paths: string[]; recordedAt: string } }[];
  targets: {
    target: { targetId: string; managedRef: string };
    currentHeadRef: { id: string; digest: string };
  }[];
  sloIncidents: {
    incident: { kind: string; status: string; observed: string; limit: string };
  }[];
  attention: {
    openPackets: number;
    routinePages: number;
    safetyCriticalPages: number;
    activeHumanTimeMs: number;
  };
  cost: { status: string; reason?: string; amount?: string; currency?: string };
}

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  text?: string,
  className?: string
): HTMLElementTagNameMap[K] {
  const value = document.createElement(name);
  if (text !== undefined) value.textContent = text;
  if (className !== undefined) value.className = className;
  return value;
}

function labeledList(title: string, values: string[]): HTMLElement {
  const section = element("section", undefined, "detail-section");
  section.append(element("h4", title));
  if (values.length === 0) {
    section.append(element("p", "None recorded.", "muted"));
    return section;
  }
  const list = element("ul");
  for (const value of values) list.append(element("li", value));
  section.append(list);
  return section;
}

function renderMilestone(snapshot: MilestoneSnapshot): HTMLElement {
  const article = element("article", undefined, "milestone-card");
  const header = element("header", undefined, "card-header");
  const heading = element("h2", snapshot.milestone.contract.title);
  heading.tabIndex = 0;
  const state = snapshot.outcomePacket?.packet.recommendation ?? snapshot.milestone.status;
  const badge = element("span", `Status: ${state}`, `status status-${state}`);
  header.append(heading, badge);
  article.append(header);
  article.append(element("p", snapshot.milestone.contract.objective));

  const intent = snapshot.program.intent;
  const intentSection = element("section", undefined, "detail-section");
  intentSection.append(element("h3", `Approved intent — ${snapshot.program.name}`));
  intentSection.append(
    element("p", intent?.objective ?? "Legacy program without approved intent.")
  );
  if (intent) {
    intentSection.append(element("p", `Risk class: ${intent.riskClass}`, "metadata"));
    intentSection.append(labeledList("Tenets", intent.tenets));
    intentSection.append(labeledList("Non-goals", intent.nonGoals));
  }
  article.append(intentSection);

  const criteria =
    snapshot.outcomePacket?.packet.criteriaResults ??
    snapshot.milestone.contract.criteria.map((criterion) => ({
      ...criterion,
      result: "unverified" as const
    }));
  article.append(
    labeledList(
      "Criteria",
      criteria.map(
        (criterion) =>
          `${criterion.result.toUpperCase()}: ${criterion.statement} [${criterion.criterionId}]`
      )
    )
  );

  article.append(
    labeledList(
      "Attempts and retries",
      snapshot.attempts.map((attempt) => {
        const usage = attempt.cumulativeUsage
          ? `; ${String(attempt.cumulativeUsage.cpuMillis)} ms CPU, ${String(attempt.cumulativeUsage.memoryPeakBytes)} bytes peak`
          : "";
        return `#${String(attempt.ordinal)} ${attempt.status}; ${attempt.terminationReason ?? "no terminal reason"}${usage}`;
      })
    )
  );
  article.append(
    labeledList(
      "Verification",
      snapshot.verifications.map(
        (verification) =>
          `${verification.status}: ${verification.verificationId}${verification.failureReason ? ` — ${verification.failureReason}` : ""}`
      )
    )
  );
  article.append(
    labeledList(
      "Driver receipts and usage",
      snapshot.driverReceipts.map(
        (receipt) =>
          `${receipt.outcome}: ${receipt.driverReceiptId}; ${String(receipt.receipt.usage.cpuMillis)} ms CPU, ${String(receipt.receipt.usage.memoryPeakBytes)} bytes peak`
      )
    )
  );
  const revision = element("p", undefined, "metadata");
  revision.textContent = `Candidate revision: ${snapshot.job?.candidateRevisionId ?? "not captured"}`;
  article.append(revision);
  if (snapshot.outcomePacket) {
    const outcome = element("section", undefined, "outcome");
    outcome.append(
      element("h3", `Recommendation: ${snapshot.outcomePacket.packet.recommendation}`)
    );
    outcome.append(element("p", snapshot.outcomePacket.packet.summary));
    const link = element("a", "Inspect outcome packet JSON");
    link.href = `/api/outcome-packets/${snapshot.outcomePacket.outcomePacketId}`;
    outcome.append(link);
    article.append(outcome);
  }
  if (snapshot.run) {
    const trace = element("a", "Inspect execution trace");
    trace.href = `/api/traces/${snapshot.run.runId}`;
    trace.className = "secondary-link";
    article.append(trace);
  }
  return article;
}

function renderPortfolio(snapshot: PortfolioSnapshot): HTMLElement {
  const section = element("section", undefined, "milestone-card");
  const header = element("header", undefined, "card-header");
  header.append(
    element("h2", "Controlled portfolio"),
    element(
      "span",
      snapshot.admissionFrozen ? "Admission frozen" : "Admission open",
      `status ${snapshot.admissionFrozen ? "status-reject" : "status-merge"}`
    )
  );
  section.append(header);
  section.append(
    element("p", `Authoritative through event ${String(snapshot.throughPosition)}.`, "metadata")
  );
  section.append(
    labeledList(
      "Programs and eligibility",
      snapshot.programs.map((program) => {
        const blockers =
          snapshot.eligibilityBlockers.find((entry) => entry.programId === program.programId)
            ?.blockers ?? [];
        return `${program.name} [${program.programId}] — ${program.phase ?? "legacy"}; ${blockers.length === 0 ? "eligible" : `blocked: ${blockers.join(", ")}`}`;
      })
    ),
    labeledList(
      "Active claims and fencing",
      snapshot.activeClaims.map(
        ({ lease }) =>
          `${lease.claimKind}:${lease.claimKey} — ${lease.programId}; fence ${String(lease.fencingToken)}; expires ${lease.expiresAt}`
      )
    ),
    labeledList(
      "Sticky lease recovery",
      snapshot.leaseRecovery.map(
        ({ lease }) =>
          `${lease.claimKey} remains unavailable for ${lease.programId} since ${lease.expiresAt}`
      )
    ),
    labeledList(
      "Integration order and age",
      snapshot.integrationOrder.map(
        ({ candidate, status }) =>
          `#${String(candidate.finalAdmissionSequence)} ${candidate.candidateId} (${candidate.programId}) — ${status}; queued ${candidate.queuedAt}`
      )
    ),
    labeledList(
      "Integration work",
      snapshot.integrationWork.map(
        ({ work }) => `${work.workId} for ${work.candidateId} — ${work.status}`
      )
    ),
    labeledList(
      "Conflicts",
      snapshot.conflicts.map(
        ({ conflict }) =>
          `${conflict.candidateId}: ${conflict.paths.join(", ")} (${conflict.recordedAt})`
      )
    ),
    labeledList(
      "Managed target heads",
      snapshot.targets.map(
        ({ target, currentHeadRef }) =>
          `${target.targetId} ${target.managedRef} → ${currentHeadRef.id}@${currentHeadRef.digest}`
      )
    ),
    labeledList(
      "SLO incidents",
      snapshot.sloIncidents.map(
        ({ incident }) =>
          `${incident.kind} ${incident.status}: ${incident.observed} / ${incident.limit}`
      )
    )
  );
  section.append(
    element(
      "p",
      `Attention: ${String(snapshot.attention.openPackets)} open; ${String(snapshot.attention.routinePages)} routine pages; ${String(snapshot.attention.safetyCriticalPages)} safety pages; ${String(snapshot.attention.activeHumanTimeMs)} ms human time. Cost: ${snapshot.cost.status === "unavailable" ? (snapshot.cost.reason ?? "unavailable") : `${snapshot.cost.amount ?? "0"} ${snapshot.cost.currency ?? ""}`}.`,
      "metadata"
    )
  );
  return section;
}

function renderAdvisor(snapshot: AdvisorSnapshot): HTMLElement {
  const section = element("section", undefined, "milestone-card");
  const active = snapshot.policies.filter((entry) => entry.status === "active");
  const openIncidents = snapshot.incidents.filter((entry) => entry.incident.status === "open");
  const pendingAudits = snapshot.audits.filter((entry) => entry.audit.status === "pending");
  const header = element("header", undefined, "card-header");
  header.append(
    element("h2", "Advisor evidence and authority"),
    element(
      "span",
      openIncidents.length > 0 ? "Authority needs attention" : `${String(active.length)} active`,
      `status ${openIncidents.length > 0 ? "status-reject" : "status-merge"}`
    )
  );
  section.append(header);
  section.append(
    element("p", `Authoritative through event ${String(snapshot.throughPosition)}.`, "metadata"),
    labeledList(
      "Approved subjects",
      snapshot.subjects.map(
        ({ subject }) =>
          `${subject.name} [${subject.subjectId}] revision ${String(subject.revision)}`
      )
    ),
    labeledList(
      "Evaluation gates",
      snapshot.evaluations.map(
        ({ report }) =>
          `${report.reportId}: ${report.promotionEligible ? "eligible" : `blocked: ${report.blockers.join(", ")}`}; coverage ${(report.holdout.coverage * 100).toFixed(1)}%; Wilson LCB ${(report.holdout.wilsonLowerBound * 100).toFixed(1)}%; serious ${String(report.holdout.seriousDisagreementCount)}`
      )
    ),
    labeledList(
      "Policies and automatic use",
      snapshot.policies.map(
        ({ policy, status, automaticResolutionCount }) =>
          `${policy.policyRevisionId}: ${status}; ${String(automaticResolutionCount)}/200 automatic resolutions; owner ${policy.owner}; expires ${policy.expiresAt}`
      )
    ),
    labeledList(
      "Pending audits",
      pendingAudits.map(({ audit }) => `${audit.auditId}: due ${audit.dueAt}`)
    ),
    labeledList(
      "Incidents",
      snapshot.incidents.map(
        ({ incident }) => `${incident.kind} ${incident.status}: ${incident.detail}`
      )
    ),
    labeledList(
      "Promotion blockers",
      snapshot.blockers.map((entry) => `${entry.policyRevisionId}: ${entry.reasons.join(", ")}`)
    )
  );
  return section;
}

async function refresh(): Promise<void> {
  const status = document.querySelector<HTMLElement>("#refresh-status");
  const portfolio = document.querySelector<HTMLElement>("#portfolio");
  const advisor = document.querySelector<HTMLElement>("#advisor");
  const root = document.querySelector<HTMLElement>("#milestones");
  if (!status || !portfolio || !advisor || !root) return;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    const snapshot = (await response.json()) as ExplorerSnapshot;
    portfolio.replaceChildren(renderPortfolio(snapshot.portfolio));
    advisor.replaceChildren(renderAdvisor(snapshot.advisor));
    const fragment = document.createDocumentFragment();
    if (snapshot.milestones.length === 0) {
      fragment.append(element("p", "No approved milestones yet.", "empty-state"));
    } else {
      for (const milestone of snapshot.milestones) fragment.append(renderMilestone(milestone));
    }
    root.replaceChildren(fragment);
    status.textContent = `Updated ${new Date(snapshot.generatedAt).toLocaleTimeString()}`;
  } catch (error) {
    status.textContent = `Refresh failed: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

void refresh();
window.setInterval(() => void refresh(), 2_000);
