import type {
  AdvisorSnapshotV1,
  AttentionSnapshotV1,
  AttentionSnapshotV2,
  CommandResult,
  DecisionAudit,
  OutboundAuthoritySnapshotV1,
  OutboundPolicyPromotionV1
} from "@parallelplay/kernel";

export interface AttentionSession {
  operatorId: string;
  csrfToken: string;
}

export interface AttentionActionBinding {
  optionId: string;
  actionKind:
    | "approve"
    | "retry"
    | "cancel"
    | "park"
    | "reprioritize"
    | "integrate"
    | "promote_advisor_policy";
  targetPreconditionDigest: string;
  integrationContext?: {
    candidateId: string;
    expectedHeadRef: unknown;
    rebasedCandidateRef: unknown;
    finalOutcomeRef: unknown;
    diffManifestRef: unknown;
    integrationVerificationRef: unknown;
  };
}

export interface AttentionPacketResponse {
  audit: DecisionAudit;
  actionBindings: AttentionActionBinding[];
}

interface BoundRevision {
  packetRevisionId: string;
  packetRevisionDigest: string;
}

export class AttentionClient {
  readonly #baseUrl: string;
  #session: AttentionSession | null = null;

  constructor(baseUrl = "") {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  get session(): AttentionSession | null {
    return this.#session;
  }

  async bootstrap(token: string): Promise<AttentionSession> {
    const response = await this.#request<AttentionSession>("/api/bootstrap", {
      method: "POST",
      body: { token },
      sessionRequired: false
    });
    this.#session = response;
    return response;
  }

  async restore(): Promise<AttentionSession> {
    const response = await this.#request<AttentionSession>("/api/session", {
      method: "GET",
      sessionRequired: false
    });
    this.#session = response;
    return response;
  }

  snapshot(): Promise<AttentionSnapshotV1> {
    return this.#request<AttentionSnapshotV1>("/api/snapshot", { method: "GET" });
  }

  advisorSnapshot(): Promise<AdvisorSnapshotV1> {
    return this.#request<AdvisorSnapshotV1>("/api/advisor", { method: "GET" });
  }

  snapshotV2(): Promise<AttentionSnapshotV2> {
    return this.#request<AttentionSnapshotV2>("/api/snapshot-v2", { method: "GET" });
  }

  packet(packetId: string): Promise<AttentionPacketResponse> {
    return this.#request<AttentionPacketResponse>(`/api/decisions/${packetId}`, {
      method: "GET"
    });
  }

  acknowledge(
    packetId: string,
    revision: BoundRevision,
    acknowledgementId = crypto.randomUUID(),
    idempotencyKey = crypto.randomUUID()
  ): Promise<CommandResult> {
    return this.#write(`/api/decisions/${packetId}/acknowledge`, {
      idempotencyKey,
      acknowledgementId,
      ...revision
    });
  }

  act(
    packetId: string,
    actionKind: AttentionActionBinding["actionKind"],
    revision: BoundRevision,
    optionId: string,
    targetPreconditionDigest: string,
    integrationContext?: AttentionActionBinding["integrationContext"],
    idempotencyKey = crypto.randomUUID()
  ): Promise<CommandResult> {
    const pathAction =
      actionKind === "promote_advisor_policy" ? "promote-advisor-policy" : actionKind;
    return this.#write(`/api/decisions/${packetId}/${pathAction}`, {
      idempotencyKey,
      optionId,
      targetPreconditionDigest,
      ...(actionKind === "promote_advisor_policy" ? { promotionId: crypto.randomUUID() } : {}),
      ...(integrationContext ?? {}),
      ...revision
    });
  }

  reviewAdvisorAudit(
    auditId: string,
    finding: "agree" | "benign_disagreement" | "serious_disagreement" | "harm",
    notes: string | null = null,
    idempotencyKey = crypto.randomUUID()
  ): Promise<CommandResult> {
    return this.#write(`/api/advisor-audits/${auditId}/review`, {
      idempotencyKey,
      finding,
      evidenceRefs: [],
      notes
    });
  }

  dismissAdvisorProposal(
    proposalId: string,
    reason = "Dismissed in attention review",
    idempotencyKey = crypto.randomUUID()
  ): Promise<CommandResult> {
    return this.#write(`/api/advisor-proposals/${proposalId}/dismiss`, {
      idempotencyKey,
      reason
    });
  }

  startGitHubSetup(): Promise<{ launchPath: string }> {
    return this.#request<{ launchPath: string }>("/api/github/setup/start", {
      method: "POST",
      body: {}
    });
  }

  verifyGitHubInstallation(installationId: string): Promise<{ repository: string }> {
    return this.#request<{ repository: string }>("/api/github/setup/installation", {
      method: "POST",
      body: { installationId }
    });
  }

  outboundSnapshot(): Promise<OutboundAuthoritySnapshotV1> {
    return this.#request<OutboundAuthoritySnapshotV1>("/api/outbound", { method: "GET" });
  }

  promoteFixtureGitHubPolicy(
    policyRevisionId = crypto.randomUUID()
  ): Promise<OutboundPolicyPromotionV1> {
    return this.#writeOutbound<OutboundPolicyPromotionV1>("/api/outbound/github-policy/promote", {
      policyRevisionId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      confirmation: "Promote fixture-only GitHub effects"
    });
  }

  suspendFixtureGitHubPolicy(promotionDigest: string): Promise<OutboundAuthoritySnapshotV1> {
    return this.#writeOutbound<OutboundAuthoritySnapshotV1>("/api/outbound/github-policy/suspend", {
      promotionDigest,
      reason: "Operator suspended the fixture-only GitHub pilot policy"
    });
  }

  runFixtureGitHubPilot(promotionDigest: string): Promise<unknown> {
    return this.#writeOutbound<unknown>("/api/github/pilot/run", {
      promotionDigest,
      confirmation: "Run fixture-only GitHub pilot"
    });
  }

  #writeOutbound<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.#request<T>(path, { method: "POST", body });
  }

  #write(path: string, body: Record<string, unknown>): Promise<CommandResult> {
    return this.#request<CommandResult>(path, { method: "POST", body });
  }

  async #request<T>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      sessionRequired?: boolean;
    }
  ): Promise<T> {
    if (options.sessionRequired !== false && !this.#session) {
      throw new Error("Attention session is not established");
    }
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: options.method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(this.#session ? { "x-csrf-token": this.#session.csrfToken } : {})
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    const value = (await response.json()) as { ok: boolean; data?: T; error?: string };
    if (!response.ok || !value.ok || value.data === undefined) {
      throw new Error(
        value.error ?? `Attention request failed with HTTP ${String(response.status)}`
      );
    }
    return value.data;
  }
}
