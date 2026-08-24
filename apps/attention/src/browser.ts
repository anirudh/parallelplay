import { AttentionClient } from "./client.js";
import type { AttentionActionBinding, AttentionPacketResponse } from "./client.js";
import type {
  AdvisorSnapshotV1,
  AttentionQueueItem,
  AttentionSnapshotV1
} from "@parallelplay/kernel";

const client = new AttentionClient();
let activeGitHubPromotionDigest: string | null = null;

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

function evidenceSection(title: string, value: unknown): HTMLElement {
  const section = element("section");
  section.append(element("h3", title));
  section.append(element("pre", JSON.stringify(value, null, 2), "muted"));
  return section;
}

function bindingFor(
  packet: AttentionPacketResponse,
  optionId: string
): AttentionActionBinding | undefined {
  return packet.actionBindings.find((entry) => entry.optionId === optionId);
}

async function packetCard(
  item: AttentionQueueItem,
  snapshot: AttentionSnapshotV1
): Promise<HTMLElement> {
  const detail = await client.packet(item.packet.packetId);
  const revision = item.revision.revision;
  const article = element("article", undefined, "packet");
  article.dataset["packetId"] = item.packet.packetId;
  article.dataset["packetRevisionId"] = revision.packetRevisionId;
  const header = element("header");
  const title = element("h3", revision.prompt);
  title.id = `decision-${item.packet.packetId}`;
  title.tabIndex = -1;
  article.setAttribute("aria-labelledby", title.id);
  const badge = element(
    "span",
    `${revision.routing.urgency.toUpperCase()} · ${revision.routing.route}`,
    "badge"
  );
  header.append(title, badge);
  article.append(header);
  article.append(element("p", revision.context));
  article.append(
    element(
      "p",
      `Required authority: ${revision.requiredAuthority}; ${revision.safetyClass}; ${revision.reversibility}`,
      "muted"
    )
  );
  const bundle = detail.audit.evidenceBundles.find(
    (entry) => entry.bundle.evidenceBundleId === revision.evidenceBundleRef.id
  );
  const policyBinding = revision.policyBinding;
  const policy =
    policyBinding.kind === "attention_policy"
      ? snapshot.policies.find((entry) => entry.policy.policyRevisionId === policyBinding.id)
      : policyBinding;
  const grid = element("div", undefined, "evidence-grid");
  grid.append(
    evidenceSection("Primary evidence", bundle?.bundle ?? "Missing evidence bundle"),
    evidenceSection("Policy", policy ?? revision.policyBinding),
    evidenceSection("Precedent (descriptive only)", detail.audit.precedent?.precedent ?? "None")
  );
  article.append(grid);
  const controls = element("div");
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", `Actions for ${revision.prompt}`);
  if (!item.acknowledgement) {
    const acknowledge = element("button", "Acknowledge", "secondary");
    acknowledge.dataset["focusKey"] = `${item.packet.packetId}:acknowledge`;
    acknowledge.addEventListener("click", () => {
      acknowledge.disabled = true;
      void client
        .acknowledge(item.packet.packetId, {
          packetRevisionId: revision.packetRevisionId,
          packetRevisionDigest: item.revision.revisionDigest
        })
        .then(() => refresh())
        .catch(showError);
    });
    controls.append(acknowledge);
  } else {
    controls.append(
      element("p", `Acknowledged by ${item.acknowledgement.acknowledgement.actorId}`, "muted")
    );
  }
  for (const option of revision.options) {
    const binding = bindingFor(detail, option.optionId);
    if (!binding) continue;
    const button = element("button", option.label, "primary");
    button.dataset["focusKey"] = `${item.packet.packetId}:${binding.actionKind}:${option.optionId}`;
    button.title = `${option.consequences.join(" ")} Reversal cost: ${option.reversalCost}`;
    button.addEventListener("click", () => {
      button.disabled = true;
      void client
        .act(
          item.packet.packetId,
          binding.actionKind,
          {
            packetRevisionId: revision.packetRevisionId,
            packetRevisionDigest: item.revision.revisionDigest
          },
          option.optionId,
          binding.targetPreconditionDigest,
          binding.integrationContext
        )
        .then(() => refresh())
        .catch(showError);
    });
    controls.append(button);
  }
  article.append(controls);
  return article;
}

function showError(error: unknown): void {
  const status = document.querySelector<HTMLElement>("#status");
  if (status)
    status.textContent = error instanceof Error ? error.message : "Attention request failed";
}

async function renderList(
  root: HTMLElement,
  items: AttentionQueueItem[],
  snapshot: AttentionSnapshotV1
): Promise<void> {
  if (items.length === 0) {
    root.replaceChildren(element("p", "No open decisions.", "muted"));
    return;
  }
  const cards = await Promise.all(items.map((item) => packetCard(item, snapshot)));
  root.replaceChildren(...cards);
}

function renderAdvisor(root: HTMLElement, snapshot: AdvisorSnapshotV1): void {
  const fragment = document.createDocumentFragment();
  const summary = element(
    "p",
    `${String(snapshot.policies.filter((entry) => entry.status === "active").length)} active policies; ${String(snapshot.audits.filter((entry) => entry.audit.status === "pending").length)} pending audits; ${String(snapshot.incidents.filter((entry) => entry.incident.status === "open").length)} open incidents.`,
    "muted"
  );
  fragment.append(summary);
  for (const entry of snapshot.proposals.filter((candidate) => candidate.status === "open")) {
    const article = element("article", undefined, "packet");
    article.append(
      element("h3", "Advisor policy proposal"),
      element(
        "p",
        `${entry.proposal.rationale} Support: ${String(entry.proposal.supportingCaseRefs.length)} cases across ${String(entry.proposal.supportingProgramIds.length)} programs.`,
        "muted"
      )
    );
    const dismiss = element("button", "Dismiss proposal", "secondary");
    dismiss.dataset["focusKey"] = `advisor-proposal:${entry.proposal.proposalId}:dismiss`;
    dismiss.addEventListener("click", () => {
      dismiss.disabled = true;
      void client
        .dismissAdvisorProposal(entry.proposal.proposalId)
        .then(() => refresh())
        .catch(showError);
    });
    article.append(dismiss);
    fragment.append(article);
  }
  for (const entry of snapshot.audits.filter((candidate) => candidate.audit.status === "pending")) {
    const article = element("article", undefined, "packet");
    article.append(
      element("h3", `Audit automatic resolution ${entry.audit.resolutionRef.id}`),
      element("p", `Due ${entry.audit.dueAt}. Policy ${entry.audit.policyRevisionRef.id}.`, "muted")
    );
    const controls = element("div");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Advisor audit finding");
    for (const [finding, label] of [
      ["agree", "Agree"],
      ["benign_disagreement", "Benign disagreement"],
      ["serious_disagreement", "Serious disagreement"],
      ["harm", "Harm"]
    ] as const) {
      const button = element("button", label, finding === "agree" ? "primary" : "secondary");
      button.dataset["focusKey"] = `advisor-audit:${entry.audit.auditId}:${finding}`;
      button.addEventListener("click", () => {
        button.disabled = true;
        void client
          .reviewAdvisorAudit(entry.audit.auditId, finding)
          .then(() => refresh())
          .catch(showError);
      });
      controls.append(button);
    }
    article.append(controls);
    fragment.append(article);
  }
  root.replaceChildren(fragment);
}

async function refresh(): Promise<void> {
  const status = document.querySelector<HTMLElement>("#status");
  const pages = document.querySelector<HTMLElement>("#pages");
  const queue = document.querySelector<HTMLElement>("#queue");
  const advisor = document.querySelector<HTMLElement>("#advisor");
  if (!status || !pages || !queue || !advisor) return;
  const focusKey =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset["focusKey"]
      : undefined;
  try {
    const [combined, outbound] = await Promise.all([
      client.snapshotV2(),
      client.outboundSnapshot()
    ]);
    const snapshot = combined.attention;
    const advisorSnapshot = combined.advisor;
    await Promise.all([
      renderList(pages, snapshot.page, snapshot),
      renderList(queue, snapshot.queue, snapshot)
    ]);
    renderAdvisor(advisor, advisorSnapshot);
    const activePolicy = outbound.policies.find(
      (entry) =>
        entry.status === "active" &&
        entry.policy.name === "Fixture-only GitHub pilot" &&
        entry.policy.expiresAt > new Date().toISOString()
    );
    activeGitHubPromotionDigest = activePolicy?.promotionDigest ?? null;
    const policyStatus = document.querySelector<HTMLElement>("#github-policy-status");
    if (policyStatus) {
      policyStatus.textContent = activePolicy
        ? `Active until ${activePolicy.policy.expiresAt}; ${String(outbound.effects.length)} recorded effects.`
        : "No active fixture policy.";
    }
    status.textContent = `Authoritative through event position ${String(snapshot.throughPosition)}.`;
    if (focusKey) {
      const restored = [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
        (candidate) => candidate.dataset["focusKey"] === focusKey
      );
      restored?.focus();
    } else {
      const parts = location.pathname.split("/").filter(Boolean);
      const selectedPacketId = parts[0] === "decisions" ? parts[1] : undefined;
      const selectedRevisionId = new URLSearchParams(location.search).get("revision");
      const selected = [...document.querySelectorAll<HTMLElement>("article[data-packet-id]")].find(
        (candidate) =>
          candidate.dataset["packetId"] === selectedPacketId &&
          (selectedRevisionId === null ||
            candidate.dataset["packetRevisionId"] === selectedRevisionId)
      );
      selected?.querySelector<HTMLElement>("h3")?.focus();
      selected?.scrollIntoView({ block: "start" });
    }
  } catch (error) {
    showError(error);
  }
}

async function initialize(): Promise<void> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("bootstrap");
  const session = token ? await client.bootstrap(token) : await client.restore();
  if (token) history.replaceState(null, "", `${location.pathname}${location.search}`);
  const identity = document.querySelector<HTMLElement>("#identity");
  if (identity) identity.textContent = `Actions are bound to operator ${session.operatorId}.`;
  const setupButton = document.querySelector<HTMLButtonElement>("#github-setup-start");
  setupButton?.addEventListener("click", () => {
    setupButton.disabled = true;
    void client
      .startGitHubSetup()
      .then(({ launchPath }) => window.open(launchPath, "_blank", "noopener,noreferrer"))
      .catch(showError)
      .finally(() => {
        setupButton.disabled = false;
      });
  });
  const installationButton = document.querySelector<HTMLButtonElement>(
    "#github-installation-verify"
  );
  const installationInput = document.querySelector<HTMLInputElement>("#github-installation-id");
  installationButton?.addEventListener("click", () => {
    const installationId = installationInput?.value.trim() ?? "";
    installationButton.disabled = true;
    void client
      .verifyGitHubInstallation(installationId)
      .then(({ repository }) => {
        const root = document.querySelector<HTMLElement>("#github-setup .muted");
        if (root) root.textContent = `Verified fixture-only access to ${repository}.`;
      })
      .catch(showError)
      .finally(() => {
        installationButton.disabled = false;
      });
  });
  const promoteButton = document.querySelector<HTMLButtonElement>("#github-policy-promote");
  promoteButton?.addEventListener("click", () => {
    promoteButton.disabled = true;
    void client
      .promoteFixtureGitHubPolicy()
      .then(() => refresh())
      .catch(showError)
      .finally(() => {
        promoteButton.disabled = false;
      });
  });
  const suspendButton = document.querySelector<HTMLButtonElement>("#github-policy-suspend");
  const pilotButton = document.querySelector<HTMLButtonElement>("#github-pilot-run");
  pilotButton?.addEventListener("click", () => {
    const promotionDigest = activeGitHubPromotionDigest;
    if (!promotionDigest) return;
    pilotButton.disabled = true;
    void client
      .runFixtureGitHubPilot(promotionDigest)
      .then(() => refresh())
      .catch(showError)
      .finally(() => {
        pilotButton.disabled = false;
      });
  });
  suspendButton?.addEventListener("click", () => {
    const promotionDigest = activeGitHubPromotionDigest;
    if (!promotionDigest) return;
    suspendButton.disabled = true;
    void client
      .suspendFixtureGitHubPolicy(promotionDigest)
      .then(() => refresh())
      .catch(showError)
      .finally(() => {
        suspendButton.disabled = false;
      });
  });
  await refresh();
}

void initialize().catch(showError);
window.setInterval(() => void refresh(), 2_000);
