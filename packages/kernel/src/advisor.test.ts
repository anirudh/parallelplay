import { describe, expect, it } from "vitest";
import { wilsonLowerBound } from "./advisor.js";

describe("advisor scoring", () => {
  it("matches hand-checked one-sided 95 percent Wilson vectors", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(80, 100)).toBeCloseTo(0.7266961911903833, 12);
    expect(wilsonLowerBound(95, 100)).toBeCloseTo(0.9008389147209472, 12);
    expect(wilsonLowerBound(99, 100)).toBeCloseTo(0.9564182264659439, 12);
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(0.9736572792168257, 12);
  });

  it("is bounded and monotone in successes for a fixed trial count", () => {
    for (const trials of [1, 2, 5, 25, 50, 100, 1_000]) {
      let prior = 0;
      for (let successes = 0; successes <= trials; successes += 1) {
        const value = wilsonLowerBound(successes, trials);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(value).toBeGreaterThanOrEqual(prior);
        prior = value;
      }
    }
  });

  it("rejects impossible input rather than manufacturing confidence", () => {
    expect(wilsonLowerBound(-1, 100)).toBe(0);
    expect(wilsonLowerBound(101, 100)).toBe(0);
    expect(wilsonLowerBound(1, -1)).toBe(0);
  });
});
