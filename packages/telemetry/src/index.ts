import { metrics, trace, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";

const ALLOWED_ATTRIBUTE =
  /^(parallelplay\.(id|digest|outcome|duration_ms|queue_ms|retry_count|usage|cost_status|conformance|adapter|driver|version)|error\.type)$/;

export interface ParallelPlayTelemetry {
  readonly enabled: boolean;
  readonly tracer: Tracer | null;
  readonly meter: Meter | null;
  sanitize(attributes: Attributes): Attributes;
}

export function sanitizeTelemetryAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([key, value]) =>
        ALLOWED_ATTRIBUTE.test(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    )
  );
}

export function createTelemetry(options: { enabled?: boolean } = {}): ParallelPlayTelemetry {
  const enabled = options.enabled === true;
  return {
    enabled,
    tracer: enabled ? trace.getTracer("parallelplay", "0.1.0") : null,
    meter: enabled ? metrics.getMeter("parallelplay", "0.1.0") : null,
    sanitize: sanitizeTelemetryAttributes
  };
}
