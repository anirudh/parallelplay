import { describe, expect, it } from "vitest";
import { buildOciExtensionDockerArgs } from "./extension-runner.js";

describe("isolated OCI extension runner", () => {
  it("uses a digest-pinned, networkless, capability-free container", () => {
    const args = buildOciExtensionDockerArgs({
      image: `parallelplay-fixture@sha256:${"a".repeat(64)}`,
      argv: ["node", "/app/extension.js"],
      input: { hello: "world" }
    });
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args.join(" ")).not.toContain(".env");
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("rejects mutable image tags", () => {
    expect(() =>
      buildOciExtensionDockerArgs({ image: "parallelplay-fixture:latest", argv: [], input: {} })
    ).toThrow();
  });
});
