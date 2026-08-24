#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function argumentsMap(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("invalid_arguments");
    result.set(name.slice(2), value);
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let trialPhase = "setup";

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const provider = args.get("provider");
  const expected =
    provider === "openai"
      ? { model: "gpt-5.3-codex", environmentName: "OPENAI_API_KEY", manifest: "codex-sdk" }
      : provider === "anthropic"
        ? {
            model: "claude-sonnet-5",
            environmentName: "ANTHROPIC_API_KEY",
            manifest: "claude-agent-sdk"
          }
        : null;
  if (!expected) throw new Error("invalid_provider");
  if (args.get("model") !== expected.model || args.get("secret-ref") !== expected.environmentName) {
    throw new Error("locked_provider_identity_mismatch");
  }
  const budget = Number(args.get("budget-usd"));
  const inputPrice = Number(args.get("input-usd-per-million"));
  const outputPrice = Number(args.get("output-usd-per-million"));
  if (!(budget > 0 && budget <= 10 && inputPrice > 0 && outputPrice > 0)) {
    throw new Error("invalid_budget_or_pricing");
  }
  const cliRoot = resolve(args.get("cli-root") ?? "");
  const fixture = resolve(args.get("fixture") ?? "");
  const output = resolve(args.get("output") ?? "");
  const manifest = JSON.parse(readFileSync(resolve(args.get("manifest") ?? ""), "utf8"));
  if (
    manifest.id !== expected.manifest ||
    manifest.artifact?.reference?.includes("@sha256:") !== true
  ) {
    throw new Error("invalid_extension_manifest");
  }
  if (
    typeof process.env[expected.environmentName] !== "string" ||
    !process.env[expected.environmentName]
  ) {
    throw new Error("secret_reference_unavailable");
  }
  const imageManifest = JSON.parse(readFileSync(join(cliRoot, "oci", "manifest.json"), "utf8"));
  const runner = imageManifest.images?.find((entry) => entry.name === "provider-runner");
  const relay = imageManifest.images?.find((entry) => entry.name === "provider-relay");
  if (
    !runner ||
    !relay ||
    runner.reference !== manifest.artifact.reference ||
    runner.imageDigest !== manifest.artifact.sha256
  ) {
    throw new Error("cli_oci_manifest_mismatch");
  }
  for (const image of [runner, relay]) {
    const archive = join(cliRoot, "oci", `${image.name}.oci.tar`);
    if (sha256(readFileSync(archive)) !== image.archiveDigest) {
      throw new Error("oci_archive_digest_mismatch");
    }
    execFileSync("docker", ["load", "--input", archive], { stdio: "ignore" });
    execFileSync("docker", ["image", "inspect", image.reference], { stdio: "ignore" });
  }

  const runtimePath = resolve(args.get("runtime") ?? "");
  const { ContainerAgentDriver, EnvironmentSecretProvider } = await import(
    pathToFileURL(runtimePath).href
  );
  const root = mkdtempSync(join(tmpdir(), `parallelplay-${provider}-trial-`));
  const workspaceRoot = join(root, "workspaces");
  const sessionRoot = join(root, "sessions");
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  const secretProvider = new EnvironmentSecretProvider({
    environment: { [expected.environmentName]: process.env[expected.environmentName] }
  });
  const budgetPerPhase = budget / 3;
  const makeDriver = () =>
    new ContainerAgentDriver({
      manifest,
      provider,
      runnerImage: runner.reference,
      relayImage: relay.reference,
      workspaceRoot,
      sessionRoot,
      secretEnvironmentName: expected.environmentName,
      secretProvider,
      maxBudgetUsd: budgetPerPhase,
      inputUsdPerMillion: inputPrice,
      outputUsdPerMillion: outputPrice,
      maxRequests: 64
    });
  const copyFixture = (runId) => {
    const target = join(workspaceRoot, runId);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    cpSync(fixture, target, {
      recursive: true,
      filter: (source) => !/[\\/](?:\.git|node_modules|dist)(?:[\\/]|$)/.test(source)
    });
  };
  const launch = (phase, runId) => {
    const capabilityManifest = {
      schemaVersion: 3,
      workspace: "read_write",
      artifactOutput: "read_write",
      scratch: "read_write",
      context: { access: "read_only", digest: sha256(`${provider}:${phase}:context-packet`) },
      resources: {
        cpuLimit: 1,
        memoryLimitBytes: 536870912,
        pidsLimit: 64,
        wallTimeMs: 300000
      },
      network: [
        {
          broker: "provider-broker",
          provider,
          purpose: "provider_api",
          allowedModels: [expected.model]
        }
      ],
      secretHandles: ["provider-api"],
      git: []
    };
    return {
      schemaVersion: 1,
      effectKey: `${provider}:${phase}:${randomUUID()}`,
      runId,
      jobId: randomUUID(),
      attemptId: randomUUID(),
      contextDigest: sha256(`${provider}:${phase}:context`),
      executionContractDigest: sha256(`${provider}:${phase}:execution`),
      capabilityManifest,
      capabilityManifestDigest: sha256(canonical(capabilityManifest)),
      prompt:
        phase === "cancel"
          ? "Inspect the fixture carefully and wait before changing anything."
          : "Run the fixture tests, make one harmless deterministic documentation-only improvement, rerun the tests, and finish without using network access.",
      requestedModel: expected.model
    };
  };
  const poll = async (driver, sessionId, predicate, timeoutMs = 300000) => {
    const deadline = Date.now() + timeoutMs;
    let afterSequence = 0;
    const events = [];
    for (;;) {
      const batch = await driver.inspect({ schemaVersion: 1, sessionId, afterSequence });
      events.push(...batch.events);
      afterSequence = events.at(-1)?.sequence ?? afterSequence;
      if (predicate(batch, events)) return { batch, events };
      if (batch.status !== "running") return { batch, events };
      if (Date.now() >= deadline) throw new Error("provider_trial_timeout");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  };
  const receiptSummary = (receipt, events) => ({
    outcome: receipt.outcome,
    terminationReason: receipt.terminalReason,
    rawStreamDigest: receipt.rawStreamDigest,
    eventStreamDigest: receipt.eventStreamDigest,
    checkpointDigest: receipt.checkpointDigest,
    observedModels: receipt.observedModels,
    usage: events
      .filter((event) => event.type === "usage")
      .map((event) => ({
        requestedModel: event.requestedModel,
        observedModel: event.observedModel,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningTokens: event.reasoningTokens,
        monetaryCost: event.monetaryCost
      }))
  });
  const receiptFailure = (phase, receipt) => {
    const outcome = /^[a-z0-9_]{1,100}$/.test(receipt.outcome)
      ? receipt.outcome
      : `outcome_${sha256(String(receipt.outcome)).slice(0, 12)}`;
    const terminalReason = /^[a-z0-9_]{1,100}$/.test(receipt.terminalReason ?? "")
      ? receipt.terminalReason
      : `reason_${sha256(String(receipt.terminalReason)).slice(0, 12)}`;
    return `provider_${phase}_phase_${outcome}_${terminalReason}`;
  };

  const evidence = { schemaVersion: 1, provider, model: expected.model, budgetCapUsd: budget };
  const liveDrivers = [];
  try {
    trialPhase = "success";
    const successRun = randomUUID();
    copyFixture(successRun);
    const successDriver = makeDriver();
    liveDrivers.push(successDriver);
    const successLaunch = launch("success", successRun);
    const successSession = await successDriver.start(successLaunch);
    const successTerminal = await poll(
      successDriver,
      successSession.sessionId,
      (batch) => batch.status !== "running"
    );
    const successReceipt = await successDriver.collectReceipt(successSession.sessionId);
    if (successReceipt.outcome !== "succeeded") {
      throw new Error(receiptFailure("success", successReceipt));
    }
    evidence.success = receiptSummary(successReceipt, successTerminal.events);

    trialPhase = "cancellation";
    const cancelRun = randomUUID();
    copyFixture(cancelRun);
    const cancelDriver = makeDriver();
    liveDrivers.push(cancelDriver);
    const cancelLaunch = launch("cancel", cancelRun);
    const cancelSession = await cancelDriver.start(cancelLaunch);
    await cancelDriver.cancel({
      schemaVersion: 1,
      effectKey: `${cancelLaunch.effectKey}:cancel`,
      sessionId: cancelSession.sessionId,
      reason: "operator_cancelled"
    });
    const cancelTerminal = await poll(
      cancelDriver,
      cancelSession.sessionId,
      (batch) => batch.status !== "running"
    );
    const cancelReceipt = await cancelDriver.collectReceipt(cancelSession.sessionId);
    if (cancelReceipt.outcome !== "operator_cancelled") {
      throw new Error(receiptFailure("cancellation", cancelReceipt));
    }
    evidence.cancellation = receiptSummary(cancelReceipt, cancelTerminal.events);

    trialPhase = "restart_start";
    const restartRun = randomUUID();
    copyFixture(restartRun);
    const crashedDriver = makeDriver();
    liveDrivers.push(crashedDriver);
    const restartLaunch = launch("restart", restartRun);
    const restartSession = await crashedDriver.start(restartLaunch);
    trialPhase = "restart_checkpoint";
    const checkpointed = await poll(
      crashedDriver,
      restartSession.sessionId,
      (_batch, events) => events.some((event) => event.type === "checkpoint"),
      120000
    );
    const checkpoint = [...checkpointed.events]
      .reverse()
      .find((event) => event.type === "checkpoint")?.checkpointDigest;
    if (!checkpoint) throw new Error("provider_restart_checkpoint_missing");
    trialPhase = "restart_runner_discovery";
    const prefix = restartRun.replaceAll("-", "").slice(0, 20);
    const runnerNames = execFileSync(
      "docker",
      ["ps", "--filter", `name=pp-runner-${prefix}`, "--format", "{{.Names}}"],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (runnerNames.length !== 1) throw new Error("provider_restart_runner_not_found");
    trialPhase = "restart_kill";
    execFileSync("docker", ["kill", runnerNames[0]], { stdio: "ignore" });
    trialPhase = "restart_resume";
    const restartedDriver = makeDriver();
    liveDrivers.push(restartedDriver);
    await restartedDriver.resume({
      schemaVersion: 1,
      effectKey: `${restartLaunch.effectKey}:resume`,
      sessionId: restartSession.sessionId,
      checkpointDigest: checkpoint,
      contextDigest: restartLaunch.contextDigest,
      executionContractDigest: restartLaunch.executionContractDigest,
      capabilityManifestDigest: restartLaunch.capabilityManifestDigest
    });
    trialPhase = "restart_poll";
    const restartTerminal = await poll(
      restartedDriver,
      restartSession.sessionId,
      (batch) => batch.status !== "running"
    );
    trialPhase = "restart_receipt";
    const restartReceipt = await restartedDriver.collectReceipt(restartSession.sessionId);
    if (restartReceipt.outcome !== "succeeded") {
      throw new Error(receiptFailure("restart", restartReceipt));
    }
    evidence.restart = receiptSummary(restartReceipt, restartTerminal.events);
    evidence.credentialReference = expected.environmentName;
    evidence.longLivedCredentialEnteredAgent = false;
    evidence.completedAt = new Date().toISOString();
    mkdirSync(resolve(output, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${canonical(evidence)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ ok: true, evidence: basename(output) })}\n`);
  } finally {
    for (const driver of liveDrivers.reverse()) await driver.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function failureDiagnostic(error) {
  const message = error instanceof Error ? error.message : "non_error_failure";
  const phase = /^[a-z_]{1,100}$/.test(trialPhase) ? trialPhase : "unknown";
  if (/^provider_[a-z0-9_]+$/.test(message)) return message;
  if (message === "Provider relay container did not start") return "provider_relay_start_failed";
  if (message === "Contained provider process closed its protocol") {
    return "contained_provider_protocol_closed";
  }
  if (message === "Contained provider protocol timed out") {
    return "contained_provider_protocol_timed_out";
  }
  const restartBoundary =
    /^Provider restart (checkpoint validation|runtime launch|command) failed$/.exec(message);
  if (restartBoundary) {
    return `provider_restart_${restartBoundary[1].replaceAll(" ", "_")}_failed`;
  }
  const restartValidation = new Map([
    ["Provider restart host checkpoint is invalid", "host_checkpoint_invalid"],
    [
      "Provider restart binding does not match the stored host checkpoint",
      "host_checkpoint_binding_mismatch"
    ],
    ["Provider restart provider checkpoint is unreadable", "provider_checkpoint_unreadable"],
    [
      "Provider session is terminal or its restart checkpoint does not match",
      "provider_checkpoint_binding_mismatch"
    ]
  ]).get(message);
  if (restartValidation) return `provider_restart_${restartValidation}`;
  const invalidProviderCheckpoint =
    /^Provider restart provider checkpoint is invalid ([a-z0-9_]+)$/.exec(message);
  if (invalidProviderCheckpoint) {
    return `provider_restart_provider_checkpoint_invalid_${invalidProviderCheckpoint[1]}`;
  }
  const rejected = /^Provider runner rejected ([a-z]+) \(([a-z0-9_]+)\)$/.exec(message);
  if (rejected) return `provider_runner_${rejected[1]}_${rejected[2]}`;
  return `provider_${phase}_phase_internal_${sha256(message).slice(0, 12)}`;
}

await main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: "provider_trial_failed", diagnostic: failureDiagnostic(error) })}\n`
  );
  process.exitCode = 1;
});
