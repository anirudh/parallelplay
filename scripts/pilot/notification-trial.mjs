#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("invalid_arguments");
    result.set(key.slice(2), value);
  }
  return result;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const output = resolve(args.get("output") ?? "");
  const bridgePath = resolve(args.get("bridge") ?? "");
  if (!output || !bridgePath || !existsSync(bridgePath)) throw new Error("pilot_input_missing");
  const desktopManifest = JSON.parse(
    readFileSync(resolve(args.get("desktop-manifest") ?? ""), "utf8")
  );
  const webhookManifest = JSON.parse(
    readFileSync(resolve(args.get("webhook-manifest") ?? ""), "utf8")
  );
  const deepLink = new URL(args.get("attention-url") ?? "");
  if (
    deepLink.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(deepLink.hostname) ||
    !/^\/decisions\/[0-9a-f-]{36}$/.test(deepLink.pathname) ||
    !/^[0-9a-f-]{36}$/.test(deepLink.searchParams.get("revision") ?? "") ||
    [...deepLink.searchParams.keys()].some((key) => key !== "revision")
  ) {
    throw new Error("attention_url_must_bind_one_loopback_packet_revision");
  }
  const packetId = deepLink.pathname.split("/").at(-1);
  const packetRevisionId = deepLink.searchParams.get("revision");
  if (!packetId || !packetRevisionId) throw new Error("attention_identity_missing");
  const packetRevisionDigest = args.get("packet-revision-digest");
  if (!/^[a-f0-9]{64}$/.test(packetRevisionDigest ?? "")) {
    throw new Error("packet_revision_digest_required");
  }

  const kernelModule = await import(pathToFileURL(resolve(args.get("kernel") ?? "")).href);
  const adapters = await import(pathToFileURL(resolve(args.get("adapters") ?? "")).href);
  const receiverModule = await import(pathToFileURL(resolve(args.get("receiver") ?? "")).href);
  const root = mkdtempSync(join(tmpdir(), "parallelplay-notification-pilot-"));
  const databasePath = join(root, "parallelplay.db");
  const signingSecret = randomBytes(48).toString("base64url");
  let authority;
  let receiver;
  let desktop;
  let webhook;
  try {
    await kernelModule.migrateDatabase({ databasePath });
    authority = kernelModule.SqliteOutboundAuthority.open({ databasePath });
    receiver = await receiverModule.startLoopbackWebhookReceiver({
      signingSecret,
      ledgerPath: join(root, "webhook-ledger.json")
    });
    const promotion = authority.promotePolicy(
      {
        schemaVersion: 1,
        policyRevisionId: randomUUID(),
        name: "Notification pilot",
        allowedActions: ["notification.desktop.deliver", "notification.webhook.deliver"],
        targets: ["local-desktop", receiver.url],
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
      },
      { kind: "operator", id: "notification-pilot-operator" }
    );
    const payload = {
      schemaVersion: 1,
      title: "ParallelPlay attention required",
      body: "Open the exact fixture decision in Attention.",
      deepLink: deepLink.href,
      packetId,
      packetRevisionId,
      packetRevisionDigest
    };
    const payloadDigest = adapters.notificationPayloadDigest(payload);
    const effect = (adapterId, effectKey, action, target) => ({
      schemaVersion: 1,
      adapterId,
      effectKey,
      action,
      target,
      payload,
      payloadDigest,
      preconditionDigest: digest({ packetRevisionId, packetRevisionDigest }),
      policyPromotionDigest: promotion.promotionDigest
    });

    const desktopEffect = effect(
      desktopManifest.id,
      `desktop:${randomUUID()}`,
      "notification.desktop.deliver",
      "local-desktop"
    );
    desktop = new adapters.DesktopNotificationAdapter({
      manifest: desktopManifest,
      authority,
      bridge: new adapters.StdioDesktopNotificationBridge({
        executable: bridgePath,
        environment: {
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DISPLAY: process.env.DISPLAY,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY
        }
      })
    });
    const desktopReceipt = await desktop.deliver(desktopEffect);
    await desktop.close();
    desktop = null;
    const restartedDesktop = new adapters.DesktopNotificationAdapter({
      manifest: desktopManifest,
      authority,
      bridge: new adapters.StdioDesktopNotificationBridge({
        executable: bridgePath,
        environment: {
          DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
          XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
          DISPLAY: process.env.DISPLAY,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY
        }
      })
    });
    desktop = restartedDesktop;
    const desktopReconciliation = await authority.reconcileEffect(
      desktopEffect.effectKey,
      restartedDesktop
    );
    if (desktopReconciliation.status !== "observed_exact") {
      throw new Error("desktop_notification_did_not_reconcile");
    }

    const webhookEffect = effect(
      webhookManifest.id,
      `webhook:${randomUUID()}`,
      "notification.webhook.deliver",
      receiver.url
    );
    webhook = new adapters.SignedWebhookAdapter({
      manifest: webhookManifest,
      endpoint: receiver.url,
      signingSecret,
      authority
    });
    const webhookReceipt = await webhook.deliver(webhookEffect);
    await webhook.close();
    webhook = null;
    const restartedWebhook = new adapters.SignedWebhookAdapter({
      manifest: webhookManifest,
      endpoint: receiver.url,
      signingSecret,
      authority
    });
    webhook = restartedWebhook;
    const webhookReconciliation = await authority.reconcileEffect(
      webhookEffect.effectKey,
      restartedWebhook
    );
    if (webhookReconciliation.status !== "observed_exact") {
      throw new Error("signed_webhook_did_not_reconcile");
    }
    const snapshot = authority.snapshot();
    const evidence = {
      schemaVersion: 1,
      platform: `${process.platform}-${process.arch}`,
      desktop: {
        effectKey: desktopEffect.effectKey,
        receiptDigest: desktopReceipt.receiptDigest,
        observedStateDigest: desktopReceipt.observedStateDigest,
        reconciliation: desktopReconciliation,
        humanObservationRequired: process.platform === "darwin",
        clickTarget: { packetId, packetRevisionId }
      },
      webhook: {
        effectKey: webhookEffect.effectKey,
        receiptDigest: webhookReceipt.receiptDigest,
        observedStateDigest: webhookReceipt.observedStateDigest,
        reconciliation: webhookReconciliation,
        durableLoopbackLedger: true
      },
      authorityEventDigest: snapshot.eventDigest,
      secretsPersisted: false
    };
    mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${canonical(evidence)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ok: true, evidence: basename(output) })}\n`);
  } finally {
    await desktop?.close().catch(() => undefined);
    await webhook?.close().catch(() => undefined);
    await receiver?.close().catch(() => undefined);
    authority?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

await main().catch(() => {
  process.stderr.write('{"ok":false,"error":"notification_trial_failed"}\n');
  process.exitCode = 1;
});
