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
    const upstream = createServer((request, response) => {
      observedAuthorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
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
        environment: { OPENAI_API_KEY: "provider-secret" }
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

    const missingGrant = await fetch(`${endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "codex-test" })
    });
    expect(missingGrant.status).toBe(401);
  });
});
