import { createInterface } from "node:readline";
import { EnvironmentSecretProvider, ProviderEgressBroker } from "@parallelplay/runtime";
import { z } from "zod";

const InitSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().trim().min(1).max(200),
  providerSecret: z.string().min(1).max(16_384),
  advertisedHost: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  ttlMs: z.number().int().min(1_000).max(86_400_000),
  maxBudgetUsd: z.number().positive().max(100),
  inputUsdPerMillion: z.number().positive().max(10_000),
  outputUsdPerMillion: z.number().positive().max(10_000),
  maxOutputTokensPerRequest: z.number().int().positive().max(1_000_000),
  maxRequests: z.number().int().positive().max(1024),
  upstream: z.url().optional()
});

async function readInit(): Promise<z.infer<typeof InitSchema>> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    lines.close();
    return InitSchema.parse(JSON.parse(line) as unknown);
  }
  throw new Error("Provider relay initialization was not supplied");
}

const init = await readInit();
const environmentName = "PARALLELPLAY_PROVIDER_KEY";
const secretProvider = new EnvironmentSecretProvider({
  environment: { [environmentName]: init.providerSecret },
  defaultTtlMs: init.ttlMs
});
const broker = new ProviderEgressBroker({
  secretProvider,
  listenHost: "0.0.0.0",
  advertisedHost: init.advertisedHost,
  maxRequestsPerGrant: init.maxRequests,
  ...(init.upstream ? { upstreams: { [init.provider]: init.upstream } } : {})
});
await broker.start();
const grant = broker.issueGrant({
  runId: init.runId,
  provider: init.provider,
  model: init.model,
  secretEnvironmentName: environmentName,
  ttlMs: init.ttlMs,
  maxBudgetUsd: init.maxBudgetUsd,
  inputUsdPerMillion: init.inputUsdPerMillion,
  outputUsdPerMillion: init.outputUsdPerMillion,
  maxOutputTokensPerRequest: init.maxOutputTokensPerRequest
});
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: "ready", grant })}\n`);

const stop = async (): Promise<void> => {
  await broker.close();
  process.exitCode = 0;
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
