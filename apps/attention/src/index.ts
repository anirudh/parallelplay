import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { canonicalDigest, openKernel } from "@parallelplay/kernel";
import type { Kernel } from "@parallelplay/kernel";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const COOKIE_NAME = "parallelplay_attention";
const MAX_BODY_BYTES = 65_536;
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join("; ");

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ParallelPlay attention</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <header><p class="eyebrow">Local operator boundary</p><h1>Attention</h1><p id="identity">Establishing secure session…</p></header>
  <main>
    <p id="status" role="status" aria-live="polite">Loading authoritative decisions…</p>
    <section><h2>Pages</h2><div id="pages"></div></section>
    <section><h2>Queue</h2><div id="queue"></div></section>
    <section><h2>Advisor authority</h2><div id="advisor"></div></section>
  </main>
  <script type="module" src="/assets/browser.js"></script>
</body>
</html>`;

const STYLE = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
body { margin: 0; background: #0d1117; color: #eef2f8; }
header, main { max-width: 74rem; margin: 0 auto; padding: 1.5rem; }
header { border-bottom: 1px solid #303846; }
h1 { font-size: clamp(2rem, 7vw, 4rem); margin: 0; }
h2 { margin-top: 2rem; }
.eyebrow, .muted { color: #aab6c8; }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-weight: 700; }
.packet { border: 1px solid #394456; border-radius: .8rem; background: #151b24; padding: 1.2rem; margin: 1rem 0; }
.packet header { padding: 0; border: 0; display: flex; justify-content: space-between; gap: 1rem; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: .2rem .6rem; height: fit-content; }
.evidence-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
.evidence-grid section { background: #0f141c; border-radius: .5rem; padding: .8rem; overflow-wrap: anywhere; }
button { border: 0; border-radius: .45rem; padding: .65rem .9rem; margin: .3rem .3rem .3rem 0; font: inherit; font-weight: 700; cursor: pointer; }
button.primary { background: #91caff; color: #07111c; }
button.secondary { background: #303b4c; color: #eef2f8; }
button:disabled { opacity: .5; cursor: wait; }
pre { white-space: pre-wrap; font-size: .78rem; }
:focus-visible { outline: .2rem solid #ffd166; outline-offset: .2rem; }
@media (max-width: 48rem) { .evidence-grid { grid-template-columns: 1fr; } .packet header { display: block; } }
`;

function builtAsset(name: "client.js" | "browser.js"): string {
  const adjacent = new URL(`./${name}`, import.meta.url);
  const built = new URL(`../dist/${name}`, import.meta.url);
  const path = existsSync(adjacent) ? adjacent : built;
  return existsSync(path)
    ? readFileSync(path, "utf8")
    : `throw new Error(${JSON.stringify(`Attention ${name} must be built before serving`)});\n`;
}

interface Session {
  operatorId: string;
  csrfToken: string;
}

export interface AttentionServerOptions {
  databasePath: string;
  operatorId: string;
  port?: number;
}

export interface AttentionServer {
  host: "127.0.0.1";
  port: number;
  origin: string;
  bootstrapUrl: string;
  close(): Promise<void>;
}

function headers(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin"
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const serialized = `${JSON.stringify(value)}\n`;
  response.writeHead(status, headers("application/json; charset=utf-8"));
  response.end(serialized);
}

function cookie(request: IncomingMessage, name: string): string | null {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] !== "application/json") {
    throw new TypeError("content_type_must_be_application_json");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new TypeError("request_body_too_large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("request_body_must_be_an_object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decisionPath(pathname: string): { packetId: string; action: string | null } | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "decisions" || !parts[2] || !UUID.test(parts[2])) {
    return null;
  }
  if (parts.length === 3) return { packetId: parts[2], action: null };
  if (parts.length === 4) return { packetId: parts[2], action: parts[3] ?? null };
  return null;
}

function applicationDecisionPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "decisions" && UUID.test(parts[1] ?? "")
    ? (parts[1] ?? null)
    : null;
}

function advisorAuditPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 &&
    parts[0] === "api" &&
    parts[1] === "advisor-audits" &&
    UUID.test(parts[2] ?? "") &&
    parts[3] === "review"
    ? (parts[2] ?? null)
    : null;
}

function advisorProposalDismissPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 4 &&
    parts[0] === "api" &&
    parts[1] === "advisor-proposals" &&
    UUID.test(parts[2] ?? "") &&
    parts[3] === "dismiss"
    ? (parts[2] ?? null)
    : null;
}

function requireString(value: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const item = value[key];
  if (typeof item !== "string" || item.length === 0 || (pattern && !pattern.test(item))) {
    throw new TypeError(`invalid_${key}`);
  }
  return item;
}

async function executeWrite(
  kernel: Kernel,
  operatorId: string,
  packetId: string,
  action: string,
  value: Record<string, unknown>
): Promise<unknown> {
  if (action === "acknowledge") {
    if (
      !exactKeys(value, [
        "idempotencyKey",
        "acknowledgementId",
        "packetRevisionId",
        "packetRevisionDigest"
      ])
    ) {
      throw new TypeError("invalid_acknowledgement_shape");
    }
    return kernel.execute({
      type: "decision.acknowledge",
      idempotencyKey: requireString(value, "idempotencyKey"),
      actor: { kind: "operator", id: operatorId },
      payload: {
        schemaVersion: 1,
        acknowledgementId: requireString(value, "acknowledgementId", UUID),
        packetId,
        packetRevisionId: requireString(value, "packetRevisionId", UUID),
        packetRevisionDigest: requireString(value, "packetRevisionDigest", DIGEST)
      }
    });
  }
  if (action === "integrate") {
    if (
      !exactKeys(value, [
        "idempotencyKey",
        "packetRevisionId",
        "packetRevisionDigest",
        "optionId",
        "targetPreconditionDigest",
        "candidateId",
        "expectedHeadRef",
        "rebasedCandidateRef",
        "finalOutcomeRef",
        "diffManifestRef",
        "integrationVerificationRef"
      ])
    ) {
      throw new TypeError("invalid_integration_action_shape");
    }
    return kernel.execute({
      type: "decision.integrate",
      idempotencyKey: requireString(value, "idempotencyKey"),
      actor: { kind: "operator", id: operatorId },
      payload: {
        schemaVersion: 2,
        packetId,
        packetRevisionId: requireString(value, "packetRevisionId", UUID),
        packetRevisionDigest: requireString(value, "packetRevisionDigest", DIGEST),
        optionId: requireString(value, "optionId", UUID),
        targetPreconditionDigest: requireString(value, "targetPreconditionDigest", DIGEST),
        candidateId: requireString(value, "candidateId", UUID),
        expectedHeadRef: value["expectedHeadRef"],
        rebasedCandidateRef: value["rebasedCandidateRef"],
        finalOutcomeRef: value["finalOutcomeRef"],
        diffManifestRef: value["diffManifestRef"],
        integrationVerificationRef: value["integrationVerificationRef"]
      }
    });
  }
  if (action === "promote-advisor-policy") {
    if (
      !exactKeys(value, [
        "idempotencyKey",
        "promotionId",
        "packetRevisionId",
        "packetRevisionDigest",
        "optionId",
        "targetPreconditionDigest"
      ])
    ) {
      throw new TypeError("invalid_advisor_promotion_shape");
    }
    return kernel.execute({
      type: "decision.promote-advisor-policy",
      idempotencyKey: requireString(value, "idempotencyKey"),
      actor: { kind: "operator", id: operatorId },
      payload: {
        schemaVersion: 3,
        promotionId: requireString(value, "promotionId", UUID),
        packetId,
        packetRevisionId: requireString(value, "packetRevisionId", UUID),
        packetRevisionDigest: requireString(value, "packetRevisionDigest", DIGEST),
        optionId: requireString(value, "optionId", UUID),
        targetPreconditionDigest: requireString(value, "targetPreconditionDigest", DIGEST)
      }
    });
  }
  if (!["approve", "retry", "cancel", "park", "reprioritize"].includes(action)) {
    throw new TypeError("unsupported_decision_action");
  }
  if (
    !exactKeys(value, [
      "idempotencyKey",
      "packetRevisionId",
      "packetRevisionDigest",
      "optionId",
      "targetPreconditionDigest"
    ])
  ) {
    throw new TypeError("invalid_decision_action_shape");
  }
  return kernel.execute({
    type: `decision.${action}`,
    idempotencyKey: requireString(value, "idempotencyKey"),
    actor: { kind: "operator", id: operatorId },
    payload: {
      schemaVersion: 1,
      packetId,
      packetRevisionId: requireString(value, "packetRevisionId", UUID),
      packetRevisionDigest: requireString(value, "packetRevisionDigest", DIGEST),
      optionId: requireString(value, "optionId", UUID),
      targetPreconditionDigest: requireString(value, "targetPreconditionDigest", DIGEST)
    }
  });
}

export async function startAttentionServer(
  options: AttentionServerOptions
): Promise<AttentionServer> {
  if (!options.operatorId.trim()) throw new TypeError("Attention operator identity is required");
  const kernel = await openKernel({ databasePath: options.databasePath });
  let bootstrapToken: string | null = randomBytes(32).toString("base64url");
  const sessions = new Map<string, Session>();
  let expectedHost = "";
  let expectedOrigin = "";
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.host !== expectedHost) {
        json(response, 400, { ok: false, error: "invalid_host" });
        return;
      }
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== expectedOrigin) {
        json(response, 403, { ok: false, error: "invalid_origin" });
        return;
      }
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (
        request.method === "GET" &&
        (url.pathname === "/" || applicationDecisionPath(url.pathname) !== null)
      ) {
        response.writeHead(200, headers("text/html; charset=utf-8"));
        response.end(HTML);
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/style.css") {
        response.writeHead(200, headers("text/css; charset=utf-8"));
        response.end(STYLE);
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/browser.js") {
        response.writeHead(200, headers("text/javascript; charset=utf-8"));
        response.end(builtAsset("browser.js"));
        return;
      }
      if (request.method === "GET" && url.pathname === "/assets/client.js") {
        response.writeHead(200, headers("text/javascript; charset=utf-8"));
        response.end(builtAsset("client.js"));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/bootstrap") {
        if (requestOrigin !== expectedOrigin) {
          json(response, 403, { ok: false, error: "origin_required" });
          return;
        }
        const value = await body(request);
        if (!exactKeys(value, ["token"]) || value["token"] !== bootstrapToken) {
          json(response, 401, { ok: false, error: "invalid_or_consumed_bootstrap" });
          return;
        }
        bootstrapToken = null;
        const sessionId = randomBytes(32).toString("base64url");
        const session = {
          operatorId: options.operatorId,
          csrfToken: randomBytes(32).toString("base64url")
        };
        sessions.set(sessionId, session);
        response.setHeader(
          "set-cookie",
          `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`
        );
        json(response, 200, { ok: true, data: session });
        return;
      }
      const sessionId = cookie(request, COOKIE_NAME);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        json(response, 401, { ok: false, error: "session_required" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, { ok: true, data: session });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        json(response, 200, { ok: true, data: await kernel.getAttentionSnapshot() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/snapshot-v2") {
        json(response, 200, { ok: true, data: await kernel.getAttentionSnapshotV2() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/advisor") {
        json(response, 200, { ok: true, data: await kernel.getAdvisorSnapshot() });
        return;
      }
      const decision = decisionPath(url.pathname);
      if (request.method === "GET" && decision?.action === null) {
        const audit = await kernel.getDecisionAudit(decision.packetId);
        if (!audit) {
          json(response, 404, { ok: false, error: "decision_packet_not_found" });
          return;
        }
        const latest = audit.revisions.find(
          (entry) => entry.revision.packetRevisionId === audit.packet.currentRevisionId
        );
        json(response, 200, {
          ok: true,
          data: {
            audit,
            actionBindings:
              latest?.revision.options.map((option) => ({
                optionId: option.optionId,
                actionKind: option.action.kind,
                targetPreconditionDigest:
                  option.action.kind === "integrate"
                    ? option.action.target.targetPreconditionDigest
                    : option.action.kind === "promote_advisor_policy"
                      ? option.action.target.preconditionDigest
                      : canonicalDigest(option.action.target),
                ...(option.action.kind === "integrate"
                  ? {
                      integrationContext: {
                        candidateId: option.action.target.candidateId,
                        expectedHeadRef: option.action.target.expectedHeadRef,
                        rebasedCandidateRef: option.action.target.rebasedCandidateRef,
                        finalOutcomeRef: option.action.target.finalOutcomeRef,
                        diffManifestRef: option.action.target.diffManifestRef,
                        integrationVerificationRef: option.action.target.integrationVerificationRef
                      }
                    }
                  : {})
              })) ?? []
          }
        });
        return;
      }
      const advisorAuditId = advisorAuditPath(url.pathname);
      if (request.method === "POST" && advisorAuditId) {
        if (requestOrigin !== expectedOrigin) {
          json(response, 403, { ok: false, error: "origin_required" });
          return;
        }
        if (request.headers["x-csrf-token"] !== session.csrfToken) {
          json(response, 403, { ok: false, error: "invalid_csrf" });
          return;
        }
        const value = await body(request);
        if (!exactKeys(value, ["idempotencyKey", "finding", "evidenceRefs", "notes"])) {
          throw new TypeError("invalid_advisor_audit_shape");
        }
        const finding = requireString(value, "finding");
        if (!["agree", "benign_disagreement", "serious_disagreement", "harm"].includes(finding)) {
          throw new TypeError("invalid_advisor_audit_finding");
        }
        const result = await kernel.execute({
          type: "advisor-audit.record",
          idempotencyKey: requireString(value, "idempotencyKey"),
          actor: { kind: "operator", id: session.operatorId },
          payload: {
            schemaVersion: 1,
            auditId: advisorAuditId,
            finding,
            evidenceRefs: value["evidenceRefs"],
            notes: value["notes"]
          }
        });
        json(response, 200, { ok: true, data: result });
        return;
      }
      const advisorProposalId = advisorProposalDismissPath(url.pathname);
      if (request.method === "POST" && advisorProposalId) {
        if (requestOrigin !== expectedOrigin) {
          json(response, 403, { ok: false, error: "origin_required" });
          return;
        }
        if (request.headers["x-csrf-token"] !== session.csrfToken) {
          json(response, 403, { ok: false, error: "invalid_csrf" });
          return;
        }
        const value = await body(request);
        if (!exactKeys(value, ["idempotencyKey", "reason"])) {
          throw new TypeError("invalid_advisor_proposal_dismiss_shape");
        }
        const result = await kernel.execute({
          type: "decision-policy-proposal.close",
          idempotencyKey: requireString(value, "idempotencyKey"),
          actor: { kind: "operator", id: session.operatorId },
          payload: {
            schemaVersion: 1,
            proposalId: advisorProposalId,
            outcome: "dismissed",
            reason: requireString(value, "reason"),
            replacementProposalId: null
          }
        });
        json(response, 200, { ok: true, data: result });
        return;
      }
      if (request.method === "POST" && decision && decision.action !== null) {
        if (requestOrigin !== expectedOrigin) {
          json(response, 403, { ok: false, error: "origin_required" });
          return;
        }
        if (request.headers["x-csrf-token"] !== session.csrfToken) {
          json(response, 403, { ok: false, error: "invalid_csrf" });
          return;
        }
        const result = await executeWrite(
          kernel,
          session.operatorId,
          decision.packetId,
          decision.action,
          await body(request)
        );
        json(response, 200, { ok: true, data: result });
        return;
      }
      if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("allow", "GET, POST");
        json(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }
      json(response, 404, { ok: false, error: "not_found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        json(response, error instanceof TypeError ? 400 : 500, {
          ok: false,
          error: error instanceof Error ? error.message : "internal_error"
        });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await kernel.close();
    throw error;
  }
  const address = server.address() as AddressInfo;
  expectedHost = `127.0.0.1:${String(address.port)}`;
  expectedOrigin = `http://${expectedHost}`;
  return {
    host: "127.0.0.1",
    port: address.port,
    origin: expectedOrigin,
    bootstrapUrl: `${expectedOrigin}/#bootstrap=${encodeURIComponent(bootstrapToken)}`,
    close: async () => {
      sessions.clear();
      bootstrapToken = null;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await kernel.close();
    }
  };
}

export type {
  AttentionActionBinding,
  AttentionPacketResponse,
  AttentionSession
} from "./client.js";
export { AttentionClient } from "./client.js";
