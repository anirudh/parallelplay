import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import dbus from "@homebridge/dbus-native";
import { z } from "zod";
import type { DesktopNotificationBridgeV1 } from "./index.js";

const NotificationSchema = z.strictObject({
  identifier: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
  deepLink: z
    .url()
    .max(2000)
    .refine((value) => {
      const url = new URL(value);
      return (
        ["127.0.0.1", "localhost"].includes(url.hostname) &&
        ["http:", "https:"].includes(url.protocol) &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.startsWith("/decisions/") &&
        [...url.searchParams.keys()].every((key) => key === "revision") &&
        url.searchParams.has("revision")
      );
    }, "Notification deep link must identify one Attention packet revision")
});
const LedgerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.record(
    z.string().regex(/^[a-f0-9]{64}$/),
    z.strictObject({
      systemId: z.number().int().positive(),
      deepLink: z.url(),
      delivered: z.boolean()
    })
  )
});
type Ledger = z.infer<typeof LedgerSchema>;

interface DbusMessage {
  type?: number;
  interface?: string;
  member?: string;
  path?: string;
  body?: unknown[];
}

interface DbusConnection extends EventEmitter {
  end(): void;
}

interface DbusBus {
  connection: DbusConnection;
  invoke(message: unknown, callback: (error: unknown, value?: unknown) => void): void;
  addMatch(match: string, callback: (error?: unknown) => void): void;
}

interface LinuxDbusNotificationBridgeOptions {
  busAddress: string;
  stateFile: string;
  openLink?: (deepLink: string) => Promise<void>;
}

function invoke(bus: DbusBus, message: unknown): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    bus.invoke(message, (error, value) => {
      if (error)
        reject(
          error instanceof Error ? error : new Error("D-Bus invocation failed", { cause: error })
        );
      else resolvePromise(value);
    });
  });
}

async function defaultOpenLink(deepLink: string): Promise<void> {
  const child = spawn("/usr/bin/xdg-open", [deepLink], {
    detached: true,
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
  });
  child.unref();
}

export class LinuxDbusNotificationBridge implements DesktopNotificationBridgeV1 {
  readonly #bus: DbusBus;
  readonly #stateFile: string;
  readonly #openLink: (deepLink: string) => Promise<void>;
  #ledger: Ledger = { schemaVersion: 1, entries: {} };
  #ready: Promise<void>;
  #closed = false;

  constructor(options: LinuxDbusNotificationBridgeOptions) {
    if (!options.busAddress.startsWith("unix:")) {
      throw new Error("Linux notification bridge requires a local Unix D-Bus address");
    }
    this.#stateFile = resolve(options.stateFile);
    this.#openLink = options.openLink ?? defaultOpenLink;
    const api = dbus as unknown as {
      sessionBus(options: { busAddress: string }): DbusBus;
    };
    this.#bus = api.sessionBus({ busAddress: options.busAddress });
    this.#bus.connection.on("message", (message: DbusMessage) => {
      void this.#handleSignal(message).catch(() => undefined);
    });
    this.#ready = this.#initialize();
  }

  async deliver(rawNotification: {
    identifier: string;
    title: string;
    body: string;
    deepLink: string;
  }): Promise<{ systemId: string }> {
    await this.#ready;
    this.#assertOpen();
    const notification = NotificationSchema.parse(rawNotification);
    const existing = this.#ledger.entries[notification.identifier];
    const result = await invoke(this.#bus, {
      destination: "org.freedesktop.Notifications",
      path: "/org/freedesktop/Notifications",
      interface: "org.freedesktop.Notifications",
      member: "Notify",
      signature: "susssasa{sv}i",
      body: [
        "ParallelPlay",
        existing?.systemId ?? 0,
        "",
        notification.title,
        notification.body,
        ["default", "Open in Attention"],
        [
          ["x-parallelplay-identifier", ["s", notification.identifier]],
          ["x-parallelplay-deep-link", ["s", notification.deepLink]]
        ],
        -1
      ]
    });
    const systemId = z.number().int().positive().parse(result);
    this.#ledger.entries[notification.identifier] = {
      systemId,
      deepLink: notification.deepLink,
      delivered: true
    };
    await this.#persist();
    return { systemId: notification.identifier };
  }

  async query(identifier: string): Promise<{ status: "delivered" | "not_delivered" }> {
    await this.#ready;
    this.#assertOpen();
    const key = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(identifier);
    return {
      status: this.#ledger.entries[key]?.delivered ? "delivered" : "not_delivered"
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#ready;
    this.#closed = true;
    this.#bus.connection.end();
  }

  async #initialize(): Promise<void> {
    await mkdir(dirname(this.#stateFile), { recursive: true, mode: 0o700 });
    try {
      const metadata = await stat(this.#stateFile);
      if ((metadata.mode & 0o077) !== 0 || (process.getuid && metadata.uid !== process.getuid())) {
        throw new Error("Linux notification ledger is not owner-only");
      }
      this.#ledger = LedgerSchema.parse(JSON.parse(await readFile(this.#stateFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolvePromise, reject) => {
      this.#bus.addMatch("type='signal',interface='org.freedesktop.Notifications'", (error) => {
        if (error)
          reject(
            error instanceof Error ? error : new Error("D-Bus match setup failed", { cause: error })
          );
        else resolvePromise();
      });
    });
  }

  async #handleSignal(message: DbusMessage): Promise<void> {
    if (
      message.interface !== "org.freedesktop.Notifications" ||
      message.path !== "/org/freedesktop/Notifications" ||
      !Array.isArray(message.body)
    ) {
      return;
    }
    const systemId = z.number().int().positive().safeParse(message.body[0]);
    if (!systemId.success) return;
    const entry = Object.entries(this.#ledger.entries).find(
      ([, candidate]) => candidate.systemId === systemId.data
    );
    if (!entry) return;
    const [identifier, state] = entry;
    if (message.member === "ActionInvoked") {
      const action = z.string().safeParse(message.body[1]);
      if (action.success && ["default", "open"].includes(action.data)) {
        await this.#openLink(NotificationSchema.shape.deepLink.parse(state.deepLink));
      }
    } else if (message.member === "NotificationClosed") {
      this.#ledger.entries[identifier] = { ...state, delivered: false };
      await this.#persist();
    }
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#stateFile}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(LedgerSchema.parse(this.#ledger))}\n`, {
      mode: 0o600
    });
    await rename(temporary, this.#stateFile);
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Linux notification bridge is closed");
  }
}
