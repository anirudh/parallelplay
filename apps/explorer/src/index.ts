import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { openReadOnlyKernel } from "@parallelplay/kernel";
import type { ReadOnlyKernel } from "@parallelplay/kernel";
import {
  FileArtifactStore,
  getArtifactStoreStatus,
  getSourceStoreStatus
} from "@parallelplay/runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const clientPath = new URL("./client.js", import.meta.url);
const CLIENT = existsSync(clientPath)
  ? readFileSync(clientPath, "utf8")
  : "throw new Error('Explorer client must be built before serving');\n";
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ParallelPlay execution explorer</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; }
    body { margin: 0; background: #10131a; color: #f4f6fb; }
    header.site { padding: 2rem max(1.25rem, 5vw); border-bottom: 1px solid #343b4b; background: #171c26; }
    header.site h1 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.5rem); }
    header.site p { max-width: 65ch; color: #bdc5d6; }
    main { max-width: 76rem; margin: 0 auto; padding: 1.5rem; }
    #refresh-status { display: inline-block; margin-bottom: 1rem; color: #bdc5d6; }
    .milestone-card { border: 1px solid #3a4356; border-radius: .75rem; background: #181e29; padding: 1.25rem; margin-bottom: 1rem; box-shadow: 0 .5rem 1.5rem #0004; }
    .card-header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
    h2, h3, h4 { line-height: 1.2; }
    h2 { margin-top: 0; }
    .status { border: 1px solid currentColor; border-radius: 999px; padding: .25rem .65rem; font-weight: 700; white-space: nowrap; }
    .status-merge, .status-outcome_ready { color: #83e6a5; }
    .status-reject, .status-investigate { color: #ffb39f; }
    .status-running { color: #8ecbff; }
    .metadata, .muted { color: #bdc5d6; }
    .detail-section { border-top: 1px solid #343b4b; margin-top: 1rem; padding-top: .75rem; }
    .detail-section .detail-section { border: 0; margin: .5rem 0; padding: 0; }
    .outcome { border-left: .3rem solid #8ecbff; padding-left: 1rem; margin: 1rem 0; }
    a { color: #9fd4ff; text-underline-offset: .2rem; }
    .secondary-link { display: inline-block; margin-top: .5rem; }
    :focus-visible { outline: .2rem solid #ffd166; outline-offset: .2rem; }
    .empty-state { padding: 2rem; border: 1px dashed #56617a; border-radius: .75rem; }
    @media (max-width: 40rem) { .card-header { display: block; } .status { display: inline-block; margin-bottom: 1rem; } }
  </style>
</head>
<body>
  <header class="site">
    <h1>ParallelPlay execution explorer</h1>
    <p>Read-only local evidence for program graphs, milestone generations, routed issues, verification, candidate lineage, and measurements.</p>
  </header>
  <main>
    <p id="refresh-status" role="status" aria-live="polite">Loading authoritative snapshot…</p>
    <section id="portfolio" aria-label="Portfolio"></section>
    <section id="advisor" aria-label="Advisor authority"></section>
    <section id="milestones" aria-label="Milestones"></section>
  </main>
  <script type="module" src="/assets/client.js"></script>
</body>
</html>`;

export interface ExplorerServerOptions {
  databasePath: string;
  sourceRoot: string;
  artifactRoot: string;
  port?: number;
}

export interface ExplorerServer {
  host: "127.0.0.1";
  port: number;
  url: string;
  close(): Promise<void>;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store"
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(`${JSON.stringify(value)}\n`);
}

function segment(pathname: string, prefix: string, pattern: RegExp): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (!raw || raw.includes("/")) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return pattern.test(value) ? value : null;
}

async function completeSnapshot(kernel: ReadOnlyKernel): Promise<unknown> {
  const milestones = await kernel.listMilestones();
  const snapshots = await Promise.all(
    milestones.map((milestone) => kernel.getMilestoneSnapshot(milestone.milestoneId))
  );
  const [
    programs,
    programGraphs,
    milestoneGenerations,
    contextPackets,
    outcomeValidations,
    routedIssues,
    outcomeDispositions,
    measurementReports,
    portfolio,
    advisor
  ] = await Promise.all([
    kernel.listPrograms(),
    kernel.listProgramGraphs(),
    kernel.listMilestoneGenerations(),
    kernel.listContextPackets(),
    kernel.listOutcomeValidations(),
    kernel.listRoutedIssues(),
    kernel.listOutcomeDispositions(),
    kernel.listMeasurementReports(),
    kernel.getPortfolioSnapshot(),
    kernel.getAdvisorSnapshot()
  ]);
  return {
    snapshotVersion: 4,
    generatedAt: new Date().toISOString(),
    programs,
    milestones: snapshots.filter((value) => value !== null),
    programGraphs,
    milestoneGenerations,
    contextPackets,
    outcomeValidations,
    routedIssues,
    outcomeDispositions,
    measurementReports,
    portfolio,
    advisor
  };
}

export async function startExplorerServer(options: ExplorerServerOptions): Promise<ExplorerServer> {
  if (!getSourceStoreStatus(options.sourceRoot).valid) {
    throw new Error("Explorer source store is not initialized");
  }
  if (!getArtifactStoreStatus(options.artifactRoot).valid) {
    throw new Error("Explorer artifact store is not initialized");
  }
  const kernel = await openReadOnlyKernel({ databasePath: options.databasePath });
  const artifactStore = new FileArtifactStore(options.artifactRoot);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        json(response, 405, { ok: false, error: "method_not_allowed" });
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        response.end(HTML);
        return;
      }
      if (url.pathname === "/assets/client.js") {
        response.writeHead(200, securityHeaders("text/javascript; charset=utf-8"));
        response.end(CLIENT);
        return;
      }
      if (url.pathname === "/api/programs") {
        json(response, 200, { ok: true, data: await kernel.listPrograms() });
        return;
      }
      if (url.pathname === "/api/portfolio/snapshot") {
        json(response, 200, { ok: true, data: await kernel.getPortfolioSnapshot() });
        return;
      }
      if (url.pathname === "/api/advisor/snapshot") {
        json(response, 200, { ok: true, data: await kernel.getAdvisorSnapshot() });
        return;
      }
      if (url.pathname === "/api/program-graphs") {
        json(response, 200, { ok: true, data: await kernel.listProgramGraphs() });
        return;
      }
      if (url.pathname === "/api/generations") {
        json(response, 200, { ok: true, data: await kernel.listMilestoneGenerations() });
        return;
      }
      if (url.pathname === "/api/context-packets") {
        json(response, 200, { ok: true, data: await kernel.listContextPackets() });
        return;
      }
      if (url.pathname === "/api/outcome-validations") {
        json(response, 200, { ok: true, data: await kernel.listOutcomeValidations() });
        return;
      }
      if (url.pathname === "/api/issues") {
        json(response, 200, { ok: true, data: await kernel.listRoutedIssues() });
        return;
      }
      if (url.pathname === "/api/outcome-dispositions") {
        json(response, 200, { ok: true, data: await kernel.listOutcomeDispositions() });
        return;
      }
      if (url.pathname === "/api/measurement-reports") {
        json(response, 200, { ok: true, data: await kernel.listMeasurementReports() });
        return;
      }
      if (url.pathname === "/api/attention/snapshot") {
        const programId = url.searchParams.get("programId") ?? undefined;
        if (programId !== undefined && !UUID.test(programId)) {
          json(response, 400, { ok: false, error: "invalid_program_id" });
          return;
        }
        json(response, 200, { ok: true, data: await kernel.getAttentionSnapshot(programId) });
        return;
      }
      if (url.pathname === "/api/attention/queue") {
        const programId = url.searchParams.get("programId") ?? undefined;
        const route = url.searchParams.get("route") ?? undefined;
        if (programId !== undefined && !UUID.test(programId)) {
          json(response, 400, { ok: false, error: "invalid_program_id" });
          return;
        }
        if (route !== undefined && route !== "queue" && route !== "page") {
          json(response, 400, { ok: false, error: "invalid_route" });
          return;
        }
        json(response, 200, {
          ok: true,
          data: await kernel.listAttentionQueue(programId, route)
        });
        return;
      }
      if (url.pathname === "/api/decision-packets") {
        json(response, 200, { ok: true, data: await kernel.listDecisionPackets() });
        return;
      }
      if (url.pathname === "/api/attention-policies") {
        json(response, 200, { ok: true, data: await kernel.listAttentionPolicies() });
        return;
      }
      if (url.pathname === "/api/decision-evidence") {
        json(response, 200, { ok: true, data: await kernel.listDecisionEvidenceBundles() });
        return;
      }
      if (url.pathname === "/api/decision-precedents") {
        json(response, 200, { ok: true, data: await kernel.listDecisionPrecedents() });
        return;
      }
      if (url.pathname === "/api/attention-deliveries") {
        json(response, 200, { ok: true, data: await kernel.listAttentionDeliveries() });
        return;
      }
      if (url.pathname === "/api/attention-budget-incidents") {
        json(response, 200, { ok: true, data: await kernel.listAttentionBudgetIncidents() });
        return;
      }
      if (url.pathname === "/api/attention-measurement-reports") {
        json(response, 200, { ok: true, data: await kernel.listAttentionMeasurementReports() });
        return;
      }
      if (url.pathname === "/api/attention-digests") {
        json(response, 200, { ok: true, data: await kernel.listAttentionDigestArtifacts() });
        return;
      }
      if (url.pathname === "/api/snapshot") {
        json(response, 200, await completeSnapshot(kernel));
        return;
      }
      const milestoneId = segment(url.pathname, "/api/milestones/", UUID);
      if (milestoneId) {
        const value = await kernel.getMilestoneSnapshot(milestoneId);
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const runId = segment(url.pathname, "/api/traces/", UUID);
      if (runId) {
        const value = await kernel.getExecutionTrace(runId);
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const packetId = segment(url.pathname, "/api/outcome-packets/", UUID);
      if (packetId) {
        const value = await kernel.getState({ kind: "outcome_packet", id: packetId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const graphId = segment(url.pathname, "/api/program-graphs/", UUID);
      if (graphId) {
        const value = await kernel.getState({ kind: "program_graph", id: graphId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const generationId = segment(url.pathname, "/api/generations/", UUID);
      if (generationId) {
        const value = await kernel.getState({ kind: "milestone_generation", id: generationId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const contextPacketId = segment(url.pathname, "/api/context-packets/", UUID);
      if (contextPacketId) {
        const value = await kernel.getState({ kind: "context_packet", id: contextPacketId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const validationId = segment(url.pathname, "/api/outcome-validations/", UUID);
      if (validationId) {
        const value = await kernel.getState({ kind: "outcome_validation", id: validationId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const issueId = segment(url.pathname, "/api/issues/", UUID);
      if (issueId) {
        const value = await kernel.getState({ kind: "routed_issue", id: issueId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const dispositionId = segment(url.pathname, "/api/outcome-dispositions/", UUID);
      if (dispositionId) {
        const value = await kernel.getState({ kind: "outcome_disposition", id: dispositionId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const reportId = segment(url.pathname, "/api/measurement-reports/", UUID);
      if (reportId) {
        const value = await kernel.getState({ kind: "measurement_report", id: reportId });
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const decisionPacketId = segment(url.pathname, "/api/decision-packets/", UUID);
      if (decisionPacketId) {
        const value = await kernel.getDecisionAudit(decisionPacketId);
        json(response, value ? 200 : 404, { ok: value !== null, data: value });
        return;
      }
      const digest = segment(url.pathname, "/api/evidence/", DIGEST);
      if (digest) {
        const manifests = await kernel.listArtifactManifests();
        const entry = manifests
          .flatMap((manifest) => manifest.entries)
          .find((item) => item.sha256 === digest);
        if (!entry) {
          json(response, 404, { ok: false, error: "evidence_not_found" });
          return;
        }
        const bytes = artifactStore.read(entry);
        if (createHash("sha256").update(bytes).digest("hex") !== digest) {
          json(response, 500, { ok: false, error: "evidence_digest_mismatch" });
          return;
        }
        response.writeHead(200, {
          ...securityHeaders("application/octet-stream"),
          "content-disposition": `attachment; filename="${digest}.bin"`,
          "content-length": String(bytes.byteLength)
        });
        response.end(bytes);
        return;
      }
      json(response, 404, { ok: false, error: "not_found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        json(response, 500, {
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
  return {
    host: "127.0.0.1",
    port: address.port,
    url: `http://127.0.0.1:${String(address.port)}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await kernel.close();
    }
  };
}
