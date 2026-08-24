import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionManifestV1,
  OutboundAuthorityV1,
  OutboundEffectReceiptV1,
  OutboundEffectRequestV1,
  OutboundReconciliationV1
} from "@parallelplay/contracts";
import {
  GitHubAppAdapter,
  githubPayloadDigest,
  type GitHubEffectPayload,
  type GitHubInstallationTokenProvider
} from "./index.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface GitHubPilotAuthorityV1 extends OutboundAuthorityV1 {
  reconcileEffect(effectKey: string, adapter: GitHubAppAdapter): Promise<OutboundReconciliationV1>;
  snapshot(): {
    effects: { effectKey: string; status: string; receiptDigest: string | null }[];
    eventDigest: string;
  };
}

export interface GitHubFixturePilotOptions {
  manifest: ExtensionManifestV1;
  tokenProvider: GitHubInstallationTokenProvider;
  authority: GitHubPilotAuthorityV1;
  policyPromotionDigest: string;
  baselineCommit: string;
  candidateCommit: string;
  repository?: string;
  fetch?: typeof globalThis.fetch;
  apiBaseUrl?: string;
}

export interface GitHubFixturePilotEvidenceV1 {
  schemaVersion: 1;
  repository: "anirudh/parallelplay-fixture";
  effects: {
    action: string;
    effectKey: string;
    receiptDigest: string;
    requestId: string | null;
    externalResource: string;
    reconciliation: OutboundReconciliationV1;
  }[];
  duplicateRetryConverged: boolean;
  rejectedWithoutEffect: string[];
  authorityEventDigest: string;
}

export async function runGitHubFixturePilot(
  options: GitHubFixturePilotOptions
): Promise<GitHubFixturePilotEvidenceV1> {
  const repository = options.repository ?? "anirudh/parallelplay-fixture";
  if (repository !== "anirudh/parallelplay-fixture") {
    throw new Error("Live GitHub pilot is restricted to the public fixture repository");
  }
  if (
    !/^[a-f0-9]{40}$/.test(options.baselineCommit) ||
    !/^[a-f0-9]{40}$/.test(options.candidateCommit)
  ) {
    throw new Error("Live GitHub pilot requires exact fixture commits");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const installationToken = await options.tokenProvider.getToken();
  const repositoryResponse = await fetchImplementation(
    `${apiBaseUrl}/installation/repositories?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${installationToken}`,
        "x-github-api-version": "2026-03-10"
      },
      redirect: "manual"
    }
  );
  if (!repositoryResponse.ok) {
    throw new Error("GitHub pilot could not verify the installation scope");
  }
  const installation = (await repositoryResponse.json()) as {
    total_count?: unknown;
    repositories?: { full_name?: unknown }[];
  };
  if (
    installation.total_count !== 1 ||
    installation.repositories?.length !== 1 ||
    installation.repositories[0]?.full_name !== repository
  ) {
    throw new Error("GitHub pilot App installation is not fixture-only");
  }
  const adapter = new GitHubAppAdapter({
    manifest: options.manifest,
    tokenProvider: options.tokenProvider,
    authority: options.authority,
    fetch: fetchImplementation,
    apiBaseUrl
  });
  const pilotId = randomUUID();
  const preconditionDigest = digest(
    `${repository}:${options.baselineCommit}:${options.candidateCommit}`
  );
  const receipts: {
    request: OutboundEffectRequestV1;
    receipt: OutboundEffectReceiptV1;
  }[] = [];
  const request = (effectKey: string, payload: GitHubEffectPayload): OutboundEffectRequestV1 => ({
    schemaVersion: 1,
    adapterId: options.manifest.id,
    effectKey: `${pilotId}:${effectKey}`,
    action: payload.action,
    target: repository,
    payload,
    payloadDigest: githubPayloadDigest(payload),
    preconditionDigest,
    policyPromotionDigest: options.policyPromotionDigest
  });
  const deliver = async (name: string, payload: GitHubEffectPayload) => {
    const effect = request(name, payload);
    const receipt = await adapter.deliver(effect);
    receipts.push({ request: effect, receipt });
    return { effect, receipt };
  };

  try {
    const baselineDigest = digest(`fixture-baseline:${options.baselineCommit}`);
    const candidateDigest = digest(`fixture-candidate:${options.candidateCommit}`);
    const baselineBranch = `parallelplay/candidate/${baselineDigest}`;
    await deliver("baseline-branch", {
      action: "github.candidate-branch.create",
      revisionDigest: baselineDigest,
      commitSha: options.baselineCommit
    });
    await deliver("candidate-branch", {
      action: "github.candidate-branch.create",
      revisionDigest: candidateDigest,
      commitSha: options.candidateCommit
    });
    const draft = await deliver("draft-pr", {
      action: "github.draft-pr.create",
      revisionDigest: candidateDigest,
      base: baselineBranch,
      title: "ParallelPlay generated fixture candidate",
      body: "Generated by the bounded ParallelPlay Slice 10 pilot.",
      allowedLinkHosts: []
    });
    const pullNumber = Number(/\/pulls\/([1-9][0-9]*)$/.exec(draft.receipt.externalId)?.[1]);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
      throw new Error("GitHub draft pull receipt did not identify a pull request");
    }
    await deliver("check", {
      action: "github.check.upsert",
      headSha: options.candidateCommit,
      name: "ParallelPlay fixture pilot",
      status: "completed",
      conclusion: "success",
      title: "Bounded fixture pilot passed",
      summary: "Generated by ParallelPlay with receipt-bound authority."
    });
    await deliver("label", {
      action: "github.label.upsert",
      issueNumber: pullNumber,
      label: "parallelplay:pilot",
      color: "4f8cc9"
    });
    await deliver("comment", {
      action: "github.comment.create",
      issueNumber: pullNumber,
      body: "Generated fixture-pilot evidence is attached to this draft pull request.",
      allowedLinkHosts: []
    });
    await deliver("draft-pr-update", {
      action: "github.draft-pr.update",
      pullNumber,
      title: "ParallelPlay generated fixture candidate updated",
      body: "Generated by the bounded ParallelPlay Slice 10 pilot after reconciliation.",
      allowedLinkHosts: []
    });
    const duplicateReceipt = await adapter.deliver(draft.effect);
    const duplicateRetryConverged = duplicateReceipt.receiptDigest === draft.receipt.receiptDigest;
    if (!duplicateRetryConverged) throw new Error("GitHub duplicate retry did not converge");

    const beforeRejections = options.authority.snapshot().effects.length;
    const rejectedWithoutEffect: string[] = [];
    for (const [name, effect] of [
      [
        "merge",
        {
          ...request("reject-merge", {
            action: "github.comment.create",
            issueNumber: pullNumber,
            body: "safe",
            allowedLinkHosts: []
          }),
          action: "merge",
          payload: { action: "merge" },
          payloadDigest: digest("merge")
        }
      ],
      [
        "ready-for-review",
        {
          ...request("reject-ready", {
            action: "github.comment.create",
            issueNumber: pullNumber,
            body: "safe",
            allowedLinkHosts: []
          }),
          action: "ready-for-review",
          payload: { action: "ready-for-review" },
          payloadDigest: digest("ready-for-review")
        }
      ],
      [
        "protected-branch",
        {
          ...request("reject-protected", {
            action: "github.candidate-branch.create",
            revisionDigest: candidateDigest,
            commitSha: options.candidateCommit
          }),
          payload: {
            action: "github.candidate-branch.create",
            revisionDigest: candidateDigest,
            commitSha: options.candidateCommit,
            branch: "main"
          }
        }
      ],
      [
        "trigger-like-content",
        request("reject-trigger", {
          action: "github.comment.create",
          issueNumber: pullNumber,
          body: "/deploy production",
          allowedLinkHosts: []
        })
      ],
      [
        "secret-like-content",
        request("reject-secret", {
          action: "github.comment.create",
          issueNumber: pullNumber,
          body: ["sk", "proj", "AAAAAAAAAAAAAAAAAAAAAAAAAAAA"].join("-"),
          allowedLinkHosts: []
        })
      ]
    ] as const) {
      try {
        await adapter.deliver(effect);
      } catch {
        rejectedWithoutEffect.push(name);
      }
    }
    if (
      rejectedWithoutEffect.length !== 5 ||
      options.authority.snapshot().effects.length !== beforeRejections
    ) {
      throw new Error("GitHub rejection matrix caused an unauthorized external effect");
    }

    const effects = [];
    for (const entry of receipts) {
      const reconciliation = await options.authority.reconcileEffect(
        entry.request.effectKey,
        adapter
      );
      if (reconciliation.status !== "observed_exact") {
        throw new Error("GitHub live effect did not reconcile exactly");
      }
      effects.push({
        action: entry.request.action,
        effectKey: entry.request.effectKey,
        receiptDigest: entry.receipt.receiptDigest,
        requestId: entry.receipt.requestId,
        externalResource: entry.receipt.externalId,
        reconciliation
      });
    }
    return {
      schemaVersion: 1,
      repository,
      effects,
      duplicateRetryConverged,
      rejectedWithoutEffect,
      authorityEventDigest: options.authority.snapshot().eventDigest
    };
  } finally {
    await adapter.close();
  }
}
