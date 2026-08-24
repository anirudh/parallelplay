import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderEgressBroker } from "./provider-broker.js";
import { EnvironmentSecretProvider } from "./secret-provider.js";

const closeCallbacks: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closeCallbacks.length > 0) {
    const close = closeCallbacks.pop();
    if (close) await close();
  }
});

describe("provider egress broker", () => {
  it("keeps the provider key host-side and enforces provider, path, model, and run grant", async () => {
    let observedAuthorization = "";
    let observedBody: unknown = null;
    const upstream = createServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    closeCallbacks.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const upstreamAddress = upstream.address() as AddressInfo;
    const broker = new ProviderEgressBroker({
      secretProvider: new EnvironmentSecretProvider({
        environment: {
          OPENAI_API_KEY: "provider-secret",
          ANTHROPIC_API_KEY: "anthropic-provider-secret"
        }
      }),
      upstreams: { openai: `http://127.0.0.1:${String(upstreamAddress.port)}` }
    });
    const endpoint = await broker.start();
    closeCallbacks.push(() => broker.close());
    const grant = broker.issueGrant({
      runId: "run-1",
      provider: "openai",
      model: "codex-test",
      secretEnvironmentName: "OPENAI_API_KEY"
    });
    expect(JSON.stringify(grant)).not.toContain("provider-secret");
    expect(grant.endpoint).toBe(`${endpoint}/openai/v1`);

    const anthropicGrant = broker.issueGrant({
      runId: "run-anthropic",
      provider: "anthropic",
      model: "claude-test",
      secretEnvironmentName: "ANTHROPIC_API_KEY"
    });
    expect(anthropicGrant.endpoint).toBe(`${endpoint}/anthropic`);

    const accepted = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test", input: "hello" })
    });
    expect(accepted.status).toBe(200);
    expect(observedAuthorization).toBe("Bearer provider-secret");

    const wrongModel = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "other", input: "hello" })
    });
    expect(wrongModel.status).toBe(403);

    const forbiddenPath = await fetch(`${endpoint}/openai/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: "{}"
    });
    expect(forbiddenPath.status).toBe(403);

    const forbiddenQuery = await fetch(`${endpoint}/openai/v1/responses?redirect=example`, {
      method: "POST",
      headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test", input: "hello" })
    });
    expect(forbiddenQuery.status).toBe(403);

    expect(() =>
      broker.issueGrant({
        runId: "run-invalid-budget",
        provider: "openai",
        model: "codex-test",
        secretEnvironmentName: "OPENAI_API_KEY",
        maxBudgetUsd: 1
      })
    ).toThrow(/pricing bounds/);

    const budgeted = broker.issueGrant({
      runId: "run-budget",
      provider: "openai",
      model: "codex-test",
      secretEnvironmentName: "OPENAI_API_KEY",
      maxBudgetUsd: 1,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      maxOutputTokensPerRequest: 100
    });
    expect(budgeted.maxOutputTokensPerRequest).toBe(100);
    const bounded = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${budgeted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test", input: "hello" })
    });
    expect(bounded.status).toBe(200);
    expect(observedBody).toMatchObject({ max_output_tokens: 100 });

    const excessiveOutput = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${budgeted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test", input: "hello", max_output_tokens: 101 })
    });
    expect(excessiveOutput.status).toBe(403);

    const exhausted = broker.issueGrant({
      runId: "run-exhausted",
      provider: "openai",
      model: "codex-test",
      secretEnvironmentName: "OPENAI_API_KEY",
      maxBudgetUsd: 0.000001,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
      maxOutputTokensPerRequest: 100
    });
    const overBudget = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${exhausted.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test", input: "hello" })
    });
    expect(overBudget.status).toBe(402);

    const missingGrant = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test" })
    });
    expect(missingGrant.status).toBe(401);
  });
});
