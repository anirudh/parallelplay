#!/usr/bin/env node

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { z } from "zod";
import { LinuxDbusNotificationBridge } from "./linux-bridge.js";

const CommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("deliver"),
    input: z.strictObject({
      identifier: z.string(),
      title: z.string(),
      body: z.string(),
      deepLink: z.string()
    })
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("query"),
    input: z.strictObject({ identifier: z.string() })
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    operation: z.literal("close"),
    input: z.strictObject({})
  })
]);

const busAddress = process.env["DBUS_SESSION_BUS_ADDRESS"];
const runtimeDirectory = process.env["XDG_RUNTIME_DIR"];
if (!busAddress || !runtimeDirectory || !resolve(runtimeDirectory).startsWith("/")) {
  throw new Error(
    "Linux notification bridge requires DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR"
  );
}
const bridge = new LinuxDbusNotificationBridge({
  busAddress,
  stateFile: resolve(runtimeDirectory, "parallelplay", "notifications-v1.json")
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let requestId = "00000000-0000-4000-8000-000000000000";
  try {
    const command = CommandSchema.parse(JSON.parse(line) as unknown);
    requestId = command.requestId;
    const result =
      command.operation === "deliver"
        ? await bridge.deliver(command.input)
        : command.operation === "query"
          ? await bridge.query(command.input.identifier)
          : (await bridge.close(), { closed: true as const });
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, requestId, ok: true, result })}\n`);
    if (command.operation === "close") break;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        requestId,
        ok: false,
        error: { code: error instanceof z.ZodError ? "protocol_invalid" : "delivery_failed" }
      })}\n`
    );
  }
}
await bridge.close();
