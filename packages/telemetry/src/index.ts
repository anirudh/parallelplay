import { metrics, trace, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const SAFE_DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const SAFE_VERSION = /^(?:v)?[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;
const OUTCOMES = new Set([
  "abstained",
  "cancelled",
  "failed",
  "protocol_invalid",
  "rejected",
  "retryable",
  "succeeded",
  "terminal"
]);
const COST_STATUSES = new Set(["available", "estimated", "unavailable"]);
const CONFORMANCE_STATUSES = new Set(["failed", "passed"]);

export interface ParallelPlayTelemetry {
  readonly enabled: boolean;
  readonly tracer: Tracer | null;
  readonly meter: Meter | null;
  sanitize(attributes: Attributes): Attributes;
  shutdown(): Promise<void>;
}

export function sanitizeTelemetryAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key, value]) => isSafeAttribute(key, value))
  );
}

export function createTelemetry(options: { enabled?: boolean } = {}): ParallelPlayTelemetry {
  const enabled = options.enabled === true;
  return {
    enabled,
    tracer: enabled ? trace.getTracer("parallelplay", "0.1.0") : null,
    meter: enabled ? metrics.getMeter("parallelplay", "0.1.0") : null,
    sanitize: sanitizeTelemetryAttributes,
    shutdown: async () => undefined
  };
}

export interface OtlpTelemetryOptions {
  enabled?: boolean;
  endpoint?: string;
  serviceName?: string;
  exportIntervalMs?: number;
}

export async function startOtlpTelemetry(
  options: OtlpTelemetryOptions = {}
): Promise<ParallelPlayTelemetry> {
  if (options.enabled !== true) {
    return createTelemetry();
  }

  const endpoint = validateOtlpEndpoint(options.endpoint);
  const serviceName = options.serviceName ?? "parallelplay";
  if (!SAFE_IDENTIFIER.test(serviceName)) {
    throw new Error("telemetry serviceName must be a non-secret identifier");
  }
  const exportIntervalMs = options.exportIntervalMs ?? 60_000;
  if (
    !Number.isSafeInteger(exportIntervalMs) ||
    exportIntervalMs < 1_000 ||
    exportIntervalMs > 300_000
  ) {
    throw new Error("telemetry exportIntervalMs must be between 1000 and 300000");
  }

  const traceExporter = new OTLPTraceExporter({
    url: new URL("v1/traces", endpoint).toString(),
    headers: {},
    timeoutMillis: 5_000
  });
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: new URL("v1/metrics", endpoint).toString(),
      headers: {},
      timeoutMillis: 5_000
    }),
    exportIntervalMillis: exportIntervalMs,
    exportTimeoutMillis: 5_000
  });
  const sdk = new NodeSDK({ serviceName, traceExporter, metricReader });
  sdk.start();

  return {
    enabled: true,
    tracer: trace.getTracer("parallelplay", "0.1.0"),
    meter: metrics.getMeter("parallelplay", "0.1.0"),
    sanitize: sanitizeTelemetryAttributes,
    shutdown: async () => sdk.shutdown()
  };
}

function validateOtlpEndpoint(value: string | undefined): URL {
  if (value === undefined || value.trim() === "") {
    throw new Error("telemetry endpoint is required when OTLP export is enabled");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("telemetry endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new Error("telemetry endpoint must use https, or http for loopback only");
  }
  if (
    endpoint.protocol === "http:" &&
    endpoint.hostname !== "127.0.0.1" &&
    endpoint.hostname !== "localhost" &&
    endpoint.hostname !== "[::1]"
  ) {
    throw new Error("unencrypted telemetry export is restricted to loopback");
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "telemetry endpoint cannot contain credentials, query parameters, or fragments"
    );
  }
  if (endpoint.pathname !== "/") {
    throw new Error("telemetry endpoint must be an OTLP origin without a path");
  }
  return endpoint;
}

function isSafeAttribute(key: string, value: unknown): boolean {
  if (key === "parallelplay.digest") {
    return typeof value === "string" && SAFE_DIGEST.test(value);
  }
  if (key === "parallelplay.version") {
    return typeof value === "string" && SAFE_VERSION.test(value);
  }
  if (key === "parallelplay.outcome") {
    return typeof value === "string" && OUTCOMES.has(value);
  }
  if (key === "parallelplay.cost_status") {
    return typeof value === "string" && COST_STATUSES.has(value);
  }
  if (key === "parallelplay.conformance") {
    return typeof value === "string" && CONFORMANCE_STATUSES.has(value);
  }
  if (
    key === "parallelplay.duration_ms" ||
    key === "parallelplay.queue_ms" ||
    key === "parallelplay.retry_count" ||
    key === "parallelplay.usage"
  ) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  if (
    key === "parallelplay.id" ||
    key === "parallelplay.adapter" ||
    key === "parallelplay.driver" ||
    key === "error.type"
  ) {
    return typeof value === "string" && SAFE_IDENTIFIER.test(value);
  }
  return false;
}
