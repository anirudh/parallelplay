import { describe, expect, it } from "vitest";
import { createTelemetry, sanitizeTelemetryAttributes } from "./index.js";

describe("telemetry privacy", () => {
  it("is off by default and strips content-bearing attributes", () => {
    expect(createTelemetry().enabled).toBe(false);
    expect(
      sanitizeTelemetryAttributes({
        "parallelplay.outcome": "succeeded",
        "parallelplay.duration_ms": 42,
        prompt: "private prompt",
        source: "private source",
        token: "secret"
      })
    ).toEqual({ "parallelplay.outcome": "succeeded", "parallelplay.duration_ms": 42 });
  });
});
