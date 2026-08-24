import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import dbus from "@homebridge/dbus-native";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxDbusNotificationBridge } from "./linux-bridge.js";

const linuxIt = process.platform === "linux" ? it : it.skip;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const operation of cleanup.splice(0).reverse()) await operation();
});

interface TestBus {
  connection: { end(): void };
  exportInterface(subject: object, path: string, descriptor: object): void;
  requestName(name: string, flags: number, callback: (error?: unknown) => void): void;
}

async function startBus(): Promise<{ address: string; stop(): Promise<void> }> {
  const child = spawn(
    "dbus-daemon",
    ["--session", "--nofork", "--print-address=1", "--nopidfile"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
    }
  );
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const first = await lines[Symbol.asyncIterator]().next();
  if (first.done || !first.value.startsWith("unix:")) {
    child.kill("SIGKILL");
    throw new Error("Isolated D-Bus daemon did not publish its Unix address");
  }
  return {
    address: first.value,
    async stop() {
      lines.close();
      if (child.exitCode === null) child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    }
  };
}

async function waitUntil(operation: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await operation()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for D-Bus signal evidence");
}

describe("Linux desktop notification bridge", () => {
  linuxIt(
    "uses real D-Bus replacement IDs and routes only the exact Attention action",
    async () => {
      const daemon = await startBus();
      cleanup.push(() => daemon.stop());
      const api = dbus as unknown as {
        sessionBus(options: { busAddress: string }): TestBus;
      };
      const serviceBus = api.sessionBus({ busAddress: daemon.address });
      cleanup.push(async () => serviceBus.connection.end());
      const calls: { replacesId: number; hints: unknown }[] = [];
      class Receiver extends EventEmitter {
        #nextId = 1;
        Notify(
          _appName: string,
          replacesId: number,
          _icon: string,
          _summary: string,
          _body: string,
          _actions: string[],
          hints: unknown
        ): number {
          calls.push({ replacesId, hints });
          if (replacesId > 0) return replacesId;
          return this.#nextId++;
        }
      }
      const receiver = new Receiver();
      serviceBus.exportInterface(receiver, "/org/freedesktop/Notifications", {
        name: "org.freedesktop.Notifications",
        methods: { Notify: ["susssasa{sv}i", "u"] },
        signals: { ActionInvoked: ["us"], NotificationClosed: ["uu"] },
        properties: {}
      });
      await new Promise<void>((resolvePromise, reject) => {
        serviceBus.requestName("org.freedesktop.Notifications", 0, (error) => {
          if (error)
            reject(
              error instanceof Error ? error : new Error("D-Bus request failed", { cause: error })
            );
          else resolvePromise();
        });
      });

      const root = await mkdtemp(join(tmpdir(), "parallelplay-linux-notification-"));
      const stateFile = join(root, "notifications.json");
      const opened: string[] = [];
      const notification = {
        identifier: "a".repeat(64),
        title: "ParallelPlay needs attention",
        body: "Review the exact packet revision.",
        deepLink:
          "http://127.0.0.1:43110/decisions/10000000-0000-4000-8000-000000000001?revision=10000000-0000-4000-8000-000000000002"
      };
      const first = new LinuxDbusNotificationBridge({
        busAddress: daemon.address,
        stateFile,
        openLink: async (value) => {
          opened.push(value);
        }
      });
      expect(await first.deliver(notification)).toEqual({ systemId: notification.identifier });
      expect(await first.deliver(notification)).toEqual({ systemId: notification.identifier });
      expect(calls.map((call) => call.replacesId)).toEqual([0, 1]);
      expect(await first.query(notification.identifier)).toEqual({ status: "delivered" });
      receiver.emit("ActionInvoked", 1, "default");
      await waitUntil(() => opened.length === 1);
      expect(opened).toEqual([notification.deepLink]);
      await first.close();

      const restarted = new LinuxDbusNotificationBridge({
        busAddress: daemon.address,
        stateFile,
        openLink: async (value) => {
          opened.push(value);
        }
      });
      expect(await restarted.deliver(notification)).toEqual({ systemId: notification.identifier });
      expect(calls.at(-1)?.replacesId).toBe(1);
      receiver.emit("NotificationClosed", 1, 2);
      await waitUntil(
        async () => (await restarted.query(notification.identifier)).status === "not_delivered"
      );
      expect(await restarted.query(notification.identifier)).toEqual({ status: "not_delivered" });
      await restarted.close();
    },
    20_000
  );
});
