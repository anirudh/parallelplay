import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest, migrateDatabase, openKernel } from "@parallelplay/kernel";
import { startAttentionServer } from "./index.js";

const ids = {
  program: "72000000-0000-4000-8000-000000000001",
  request: "72000000-0000-4000-8000-000000000002",
  option: "72000000-0000-4000-8000-000000000003",
  acknowledgement: "72000000-0000-4000-8000-000000000004",
  proposal: "72000000-0000-4000-8000-000000000005"
} as const;
const directories: string[] = [];

function requestStatus(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function fixture(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "parallelplay-attention-app-"));
  directories.push(directory);
  const databasePath = join(directory, "parallelplay.db");
  await migrateDatabase({ databasePath });
  const kernel = await openKernel({ databasePath });
  const actor = { kind: "operator", id: "fixture-creator" } as const;
  try {
    expect(
      await kernel.execute({
        type: "program.create",
        idempotencyKey: "attention-app-program",
        actor,
        payload: { programId: ids.program, name: "Attention app fixture" }
      })
    ).toMatchObject({ ok: true });
    expect(
      await kernel.execute({
        type: "decision.request",
        idempotencyKey: "attention-app-request",
        actor,
        payload: {
          request: {
            schemaVersion: 1,
            requestId: ids.request,
            programId: ids.program,
            milestoneId: null,
            originalQuestion: "Should this program move ahead in the attention queue?",
            prompt: "Review and choose the exact queue-order action.",
            context: "The secure app fixture exposes one reversible action.",
            riskClass: "low",
            safetyClass: "routine",
            reversibility: "reversible",
            options: [
              {
                optionId: ids.option,
                label: "Raise priority",
                consequences: ["Attention ordering changes to p1."],
                reversalCost: "Low",
                action: {
                  kind: "reprioritize",
                  target: {
                    kind: "program_attention_priority",
                    programId: ids.program,
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
      })
    ).toMatchObject({ ok: true });
  } finally {
    await kernel.close();
  }
  return databasePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secure local attention application", () => {
  it("enforces fragment bootstrap, session, host, origin, CSRF, and typed writes", async () => {
    const databasePath = await fixture();
    let server = await startAttentionServer({
      databasePath,
      operatorId: "bound-operator",
      port: 0
    });
    const bootstrapUrl = new URL(server.bootstrapUrl);
    const token = new URLSearchParams(bootstrapUrl.hash.slice(1)).get("bootstrap");
    expect(server.host).toBe("127.0.0.1");
    expect(token?.length).toBeGreaterThanOrEqual(40);
    const html = await fetch(server.origin);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await html.text()).not.toContain(token);
    const deepLink = await fetch(
      `${server.origin}/decisions/72000000-0000-4000-8000-000000000099?revision=72000000-0000-4000-8000-000000000098`
    );
    expect(deepLink.status).toBe(200);
    expect(await deepLink.text()).toContain("<title>ParallelPlay attention</title>");
    expect(await requestStatus(server.origin, `localhost:${String(server.port)}`)).toBe(400);
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token })
        })
      ).status
    ).toBe(403);
    const bootstrap = await fetch(`${server.origin}/api/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: server.origin },
      body: JSON.stringify({ token })
    });
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
    const sessionCookie = cookie.split(";")[0] ?? "";
    const sessionValue = (await bootstrap.json()) as {
      data: { operatorId: string; csrfToken: string };
    };
    expect(sessionValue.data.operatorId).toBe("bound-operator");
    expect(
      (
        await fetch(`${server.origin}/api/bootstrap`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: server.origin },
          body: JSON.stringify({ token })
        })
      ).status
    ).toBe(401);
    expect((await fetch(`${server.origin}/api/snapshot`)).status).toBe(401);
    expect(
      (
        await fetch(`${server.origin}/api/snapshot`, {
          headers: { Cookie: sessionCookie, Origin: "http://attacker.invalid" }
        })
      ).status
    ).toBe(403);
    const snapshot = await fetch(`${server.origin}/api/snapshot`, {
      headers: { Cookie: sessionCookie }
    });
    expect(
      await (
        await fetch(`${server.origin}/api/snapshot-v2`, {
          headers: { Cookie: sessionCookie }
        })
      ).json()
    ).toMatchObject({
      ok: true,
      data: {
        snapshotVersion: 2,
        attention: { snapshotVersion: 1 },
        advisor: { snapshotVersion: 1, policies: [], incidents: [] }
      }
    });
    const snapshotValue = (await snapshot.json()) as {
      data: {
        queue: {
          packet: { packetId: string };
          revision: { revision: { packetRevisionId: string }; revisionDigest: string };
        }[];
      };
    };
    const proposalUrl = `${server.origin}/api/advisor-proposals/${ids.proposal}/dismiss`;
    expect(
      (
        await fetch(proposalUrl, {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            Origin: server.origin,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "attention-http-proposal-without-csrf",
            reason: "Typed dismissal proof"
          })
        })
      ).status
    ).toBe(403);
    expect(
      await (
        await fetch(proposalUrl, {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            Origin: server.origin,
            "x-csrf-token": sessionValue.data.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            idempotencyKey: "attention-http-proposal",
            reason: "Typed dismissal proof"
          })
        })
      ).json()
    ).toMatchObject({
      ok: true,
      data: { ok: false, error: { code: "DECISION_POLICY_CONFLICT" } }
    });
    const item = snapshotValue.data.queue[0];
    if (!item) throw new Error("Attention snapshot is missing its packet");
    const packetResponse = await fetch(`${server.origin}/api/decisions/${item.packet.packetId}`, {
      headers: { Cookie: sessionCookie }
    });
    const packetValue = (await packetResponse.json()) as {
      data: {
        actionBindings: {
          optionId: string;
          actionKind: string;
          targetPreconditionDigest: string;
        }[];
      };
    };
    const binding = packetValue.data.actionBindings[0];
    if (!binding) throw new Error("Attention packet is missing its action binding");
    const acknowledgementBody = {
      idempotencyKey: "attention-http-ack",
      acknowledgementId: ids.acknowledgement,
      packetRevisionId: item.revision.revision.packetRevisionId,
      packetRevisionDigest: item.revision.revisionDigest
    };
    expect(
      (
        await fetch(`${server.origin}/api/decisions/${item.packet.packetId}/acknowledge`, {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            Origin: server.origin,
            "content-type": "application/json"
          },
          body: JSON.stringify(acknowledgementBody)
        })
      ).status
    ).toBe(403);
    const acknowledged = await fetch(
      `${server.origin}/api/decisions/${item.packet.packetId}/acknowledge`,
      {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          Origin: server.origin,
          "x-csrf-token": sessionValue.data.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(acknowledgementBody)
      }
    );
    expect(await acknowledged.json()).toMatchObject({
      ok: true,
      data: { ok: true, data: { acknowledgement: { actorId: "bound-operator" } } }
    });

    const actionUrl = `${server.origin}/api/decisions/${item.packet.packetId}/reprioritize`;
    const staleAction = await fetch(actionUrl, {
      method: "POST",
      headers: {
        Cookie: sessionCookie,
        Origin: server.origin,
        "x-csrf-token": sessionValue.data.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        idempotencyKey: "attention-http-stale",
        packetRevisionId: item.revision.revision.packetRevisionId,
        packetRevisionDigest: "0".repeat(64),
        optionId: ids.option,
        targetPreconditionDigest: binding.targetPreconditionDigest
      })
    });
    expect(await staleAction.json()).toMatchObject({
      ok: true,
      data: { ok: false, error: { code: "DECISION_PACKET_STALE" } }
    });
    const actionHeaders = {
      Cookie: sessionCookie,
      Origin: server.origin,
      "x-csrf-token": sessionValue.data.csrfToken,
      "content-type": "application/json"
    };
    expect(
      (
        await fetch(`${server.origin}/api/decisions/${item.packet.packetId}/integrate`, {
          method: "POST",
          headers: actionHeaders,
          body: JSON.stringify({ type: "integration.promote" })
        })
      ).status
    ).toBe(400);
    const actionBody = JSON.stringify({
      idempotencyKey: "attention-http-action",
      packetRevisionId: item.revision.revision.packetRevisionId,
      packetRevisionDigest: item.revision.revisionDigest,
      optionId: ids.option,
      targetPreconditionDigest: binding.targetPreconditionDigest
    });
    const validAction = await fetch(actionUrl, {
      method: "POST",
      headers: actionHeaders,
      body: actionBody
    });
    expect(await validAction.json()).toMatchObject({
      ok: true,
      data: { ok: true, data: { result: { actorId: "bound-operator" } } }
    });
    expect(
      await (
        await fetch(actionUrl, { method: "POST", headers: actionHeaders, body: actionBody })
      ).json()
    ).toMatchObject({ ok: true, data: { ok: true, replayed: true } });
    expect(
      (
        await fetch(`${server.origin}/api/command`, {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            Origin: server.origin,
            "x-csrf-token": sessionValue.data.csrfToken,
            "content-type": "application/json"
          },
          body: JSON.stringify({ type: "program.create" })
        })
      ).status
    ).toBe(404);
    const clientAsset = await fetch(`${server.origin}/assets/client.js`);
    const clientSource = await clientAsset.text();
    expect(clientSource).not.toContain("databasePath");
    expect(clientSource).not.toContain("localStorage");
    const browserAsset = await fetch(`${server.origin}/assets/browser.js`);
    const browserSource = await browserAsset.text();
    expect(browserSource).toContain("focusKey");
    expect(browserSource).toContain("scrollIntoView");

    await server.close();
    server = await startAttentionServer({ databasePath, operatorId: "bound-operator", port: 0 });
    try {
      expect(
        (
          await fetch(`${server.origin}/api/session`, {
            headers: { Cookie: sessionCookie }
          })
        ).status
      ).toBe(401);
      expect(server.bootstrapUrl).not.toBe(bootstrapUrl.toString());
    } finally {
      await server.close();
    }

    const kernel = await openKernel({ databasePath });
    try {
      const program = await kernel.getState({ kind: "program", id: ids.program });
      expect(program).toMatchObject({ attentionPriority: "p1" });
      const packet = (await kernel.listDecisionPackets(ids.program))[0];
      expect(await kernel.getDecisionAudit(packet?.packetId ?? "")).toMatchObject({
        acknowledgements: [{ acknowledgement: { actorId: "bound-operator" } }],
        resolution: { resolution: { actorId: "bound-operator" } },
        actionResult: { result: { actorId: "bound-operator" } }
      });
      expect(canonicalDigest((await kernel.listDecisionPacketRevisions())[0]?.revision)).toMatch(
        /^[a-f0-9]{64}$/
      );
    } finally {
      await kernel.close();
    }
  });
});
