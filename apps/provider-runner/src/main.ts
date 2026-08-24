import { createInterface } from "node:readline";
import {
  DriverCancelV1Schema,
  DriverInspectV1Schema,
  DriverLaunchV1Schema,
  DriverResumeV1Schema,
  ExtensionManifestV1Schema,
  type AgentDriverV1
} from "@parallelplay/contracts";
import { ClaudeSdkDriver } from "@parallelplay/driver-claude";
import { CodexSdkDriver } from "@parallelplay/driver-codex";
import { z } from "zod";

const InitSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: z.enum(["openai", "anthropic"]),
  manifest: ExtensionManifestV1Schema,
  brokerBaseUrl: z.url(),
  brokerToken: z.string().min(32).max(512),
  maxBudgetUsd: z.number().positive().max(100)
});
const CommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("start"),
    input: DriverLaunchV1Schema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("resume"),
    input: DriverResumeV1Schema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("inspect"),
    input: DriverInspectV1Schema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("cancel"),
    input: DriverCancelV1Schema
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("receipt"),
    input: z.strictObject({ sessionId: z.string().trim().min(1).max(500) })
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("close"),
    input: z.strictObject({})
  })
]);

const protocolWrite = process.stdout.write.bind(process.stdout);
console.log = (...values: unknown[]) => process.stderr.write(`${values.map(String).join(" ")}\n`);
console.info = console.log;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const first = await iterator.next();
if (first.done) throw new Error("Provider runner initialization was not supplied");
const init = InitSchema.parse(JSON.parse(first.value) as unknown);
const common = {
  manifest: init.manifest,
  brokerBaseUrl: init.brokerBaseUrl,
  brokerToken: init.brokerToken,
  workspace: "/workspace",
  sessionDirectory: `/session/${init.provider}`,
  environment: { PARALLELPLAY_OCI_BOUNDARY: "1" }
};
const driver: AgentDriverV1 =
  init.provider === "openai"
    ? new CodexSdkDriver(common)
    : new ClaudeSdkDriver({ ...common, maxBudgetUsd: init.maxBudgetUsd });

for (;;) {
  const next = await iterator.next();
  if (next.done) break;
  let requestId = "unknown";
  try {
    const command = CommandSchema.parse(JSON.parse(next.value) as unknown);
    requestId = command.requestId;
    let result: unknown;
    switch (command.operation) {
      case "start":
        result = await driver.start(command.input);
        break;
      case "resume":
        result = await driver.resume(command.input);
        break;
      case "inspect":
        result = await driver.inspect(command.input);
        break;
      case "cancel":
        result = await driver.cancel(command.input);
        break;
      case "receipt":
        result = await driver.collectReceipt(command.input.sessionId);
        break;
      case "close":
        await driver.close();
        result = { closed: true };
        break;
    }
    protocolWrite(`${JSON.stringify({ schemaVersion: 1, requestId, ok: true, result })}\n`);
    if (command.operation === "close") break;
  } catch (error) {
    const code = error instanceof z.ZodError ? "protocol_invalid" : "driver_operation_failed";
    protocolWrite(
      `${JSON.stringify({ schemaVersion: 1, requestId, ok: false, error: { code } })}\n`
    );
  }
}
await driver.close();
