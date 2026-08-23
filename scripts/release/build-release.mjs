import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTarGz, directoryEntries, memoryEntry } from "./archive.mjs";

const VERSION = "0.1.0";
const REPOSITORY = "https://github.com/anirudh/parallelplay";
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? "1767225600");
if (!Number.isSafeInteger(epoch) || epoch <= 0)
  throw new Error("SOURCE_DATE_EPOCH must be a positive integer");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function releaseUrl(packageName) {
  const shortName = packageName.replace("@parallelplay/", "parallelplay-");
  return `${REPOSITORY}/releases/download/v${VERSION}/${shortName}-${VERSION}.tgz`;
}

function rewriteManifest(manifest, urls) {
  const rewritten = structuredClone(manifest);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!rewritten[field]) continue;
    for (const [name, value] of Object.entries(rewritten[field])) {
      if (typeof value === "string" && value.startsWith("workspace:")) {
        rewritten[field][name] = urls ? releaseUrl(name) : VERSION;
      }
    }
  }
  return `${JSON.stringify(rewritten, null, 2)}\n`;
}

function packageDirectories() {
  return readdirSync(resolve("packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve("packages", entry.name))
    .filter(
      (directory) =>
        JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).private !== true
    )
    .sort();
}

function writeArchive(outputDirectory, name, entries) {
  const bytes = createTarGz(entries, epoch);
  const path = join(outputDirectory, name);
  writeFileSync(path, bytes, { mode: 0o644 });
  return { name, path, sha256: sha256(bytes), size: bytes.length };
}

function spdxFor(artifact, components) {
  const componentPackages = components.map((component) => ({
    name: component.name,
    SPDXID: `SPDXRef-Component-${sha256(`${component.name}@${component.version}`).slice(0, 20)}`,
    versionInfo: component.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    copyrightText: "NOASSERTION"
  }));
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${artifact.name} SBOM`,
    documentNamespace: `${REPOSITORY}/releases/download/v${VERSION}/sbom/${artifact.sha256}`,
    creationInfo: {
      created: new Date(epoch * 1000).toISOString(),
      creators: ["Tool: parallelplay-release-builder-0.1.0"]
    },
    packages: [
      {
        name: artifact.name,
        SPDXID: "SPDXRef-Artifact",
        versionInfo: VERSION,
        downloadLocation: `${REPOSITORY}/releases/download/v${VERSION}/${artifact.name}`,
        filesAnalyzed: false,
        checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "Copyright (c) 2026 Anirudh C"
      },
      ...componentPackages
    ],
    relationships: componentPackages.map((component) => ({
      spdxElementId: "SPDXRef-Artifact",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: component.SPDXID
    }))
  };
}

function releasePlatform() {
  const value = `${process.platform}-${process.arch}`;
  if (!["darwin-arm64", "linux-x64", "linux-arm64"].includes(value)) {
    throw new Error(`Unsupported release platform: ${value}`);
  }
  return value === "darwin-arm64" ? "macos-arm64" : value;
}

function sourceEntries() {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    if (tracked.length === 0) throw new Error("No committed source files");
    return tracked.map((path) => {
      const bytes = readFileSync(resolve(path));
      const executable = path.startsWith("scripts/") || path.endsWith(".sh");
      return memoryEntry(`parallelplay-${VERSION}/${path}`, bytes, executable ? 0o755 : 0o644);
    });
  } catch {
    return directoryEntries(resolve("."), `parallelplay-${VERSION}`, {
      exclude: (path) =>
        path
          .split("/")
          .some((part) =>
            [".git", "node_modules", "dist", ".parallelplay-release"].includes(part)
          ) || path.endsWith(".tsbuildinfo")
    });
  }
}

function resolveDependencySource(source, dependency, optional) {
  const candidates = [join(source, "node_modules", dependency)];
  let cursor = source;
  for (;;) {
    if (basename(cursor) === "node_modules") candidates.push(join(cursor, dependency));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of candidates) {
    try {
      return realpathSync(candidate);
    } catch {
      // pnpm links peer and transitive dependencies beside the package.
    }
  }
  if (optional) return null;
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  throw new Error(
    `Cannot resolve runtime dependency ${dependency} from ${manifest.name}@${manifest.version}`
  );
}

function packageDependencyInventory(sourceDirectory) {
  const packages = new Map();
  function visit(source) {
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const identity = `${manifest.name}@${manifest.version}`;
    if (packages.has(identity)) return;
    packages.set(identity, {
      identity,
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === "string" ? manifest.license : "UNKNOWN"
    });
    for (const dependency of Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {})
    }).sort()) {
      const dependencySource = resolveDependencySource(
        source,
        dependency,
        dependency in (manifest.optionalDependencies ?? {})
      );
      if (dependencySource) visit(dependencySource);
    }
  }
  visit(sourceDirectory);
  return [...packages.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

function runtimePackageTree(sourceDirectory, archivePrefix) {
  const repositoryRoot = resolve(".");
  const entries = [];
  const licenses = new Map();
  const packages = new Map();
  const nativePrebuild = `${process.platform}-${process.arch}.node`;

  function addPackage(source, root = false) {
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const identity = `${manifest.name}@${manifest.version}`;
    const existing = packages.get(manifest.name);
    if (existing) {
      if (existing.version !== manifest.version) {
        throw new Error(`CLI dependency version conflict: ${existing.identity} and ${identity}`);
      }
      return;
    }
    packages.set(manifest.name, { identity, version: manifest.version });
    licenses.set(identity, {
      identity,
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === "string" ? manifest.license : "UNKNOWN"
    });
    const workspacePackage =
      source.startsWith(`${repositoryRoot}/packages/`) ||
      source.startsWith(`${repositoryRoot}/apps/`);
    const prefix = root ? archivePrefix : `${archivePrefix}/node_modules/${manifest.name}`;
    entries.push(
      ...directoryEntries(source, prefix, {
        exclude: (path) => {
          if (path === "package.json" || path.startsWith("node_modules/")) return true;
          if (/^\.(?:git|github)(\/|$)/.test(path)) return true;
          if (
            manifest.name === "better-sqlite3" &&
            (/^(?:build|deps|src)\//.test(path) || path === "binding.gyp")
          )
            return true;
          if (
            manifest.name === "better-sqlite3" &&
            path.startsWith("prebuilds/") &&
            path !== `prebuilds/${nativePrebuild}`
          )
            return true;
          if (/(^|\/)(?:test|tests|__tests__|bench|benchmark|example|examples)(\/|$)/i.test(path))
            return true;
          if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) || path.endsWith(".tsbuildinfo"))
            return true;
          if (
            workspacePackage &&
            (path.startsWith("src/") || path.startsWith("scripts/") || path.startsWith("tsconfig"))
          )
            return true;
          if (
            workspacePackage &&
            !["dist", "migrations"].includes(path.split("/")[0] ?? "") &&
            !/^(?:LICENSE|README\.md)$/.test(path)
          )
            return true;
          return false;
        },
        transform: (path, bytes) =>
          path === "package.json"
            ? Buffer.from(rewriteManifest(JSON.parse(bytes.toString("utf8")), false))
            : bytes
      })
    );
    entries.push(memoryEntry(`${prefix}/package.json`, rewriteManifest(manifest, false)));
    for (const dependency of Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {})
    }).sort()) {
      const dependencySource = resolveDependencySource(
        source,
        dependency,
        dependency in (manifest.optionalDependencies ?? {})
      );
      if (!dependencySource) continue;
      addPackage(dependencySource);
    }
  }

  addPackage(sourceDirectory, true);
  return {
    entries,
    licenses: [...licenses.values()].sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)
    )
  };
}

export function buildRelease(outputDirectory) {
  const output = resolve(outputDirectory);
  if (
    output === resolve(".") ||
    output === resolve("/") ||
    output === resolve(process.env.HOME ?? "/nonexistent")
  ) {
    throw new Error("Refusing unsafe release output directory");
  }
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true, mode: 0o755 });
  const primaryArtifacts = [];
  {
    const packageArtifacts = [];
    const componentInventory = new Map();
    for (const directory of packageDirectories()) {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      const name = `${manifest.name.replace("@parallelplay/", "parallelplay-")}-${VERSION}.tgz`;
      const entries = [
        memoryEntry("package/package.json", rewriteManifest(manifest, true)),
        memoryEntry("package/README.md", readFileSync(resolve("README.md"))),
        memoryEntry("package/LICENSE", readFileSync(resolve("LICENSE"))),
        ...directoryEntries(join(directory, "dist"), "package/dist", {
          exclude: (path) =>
            path.includes(".test.") ||
            path.includes(".integration.") ||
            path.endsWith(".tsbuildinfo")
        })
      ];
      if (basename(directory) === "kernel") {
        entries.push(...directoryEntries(join(directory, "migrations"), "package/migrations"));
      }
      const artifact = writeArchive(output, name, entries);
      packageArtifacts.push(artifact);
      primaryArtifacts.push(artifact);
      componentInventory.set(artifact.name, packageDependencyInventory(directory));
    }
    const sdkArtifact = writeArchive(output, `parallelplay-sdk-${VERSION}.tar.gz`, [
      memoryEntry(`parallelplay-sdk-${VERSION}/README.md`, readFileSync(resolve("README.md"))),
      memoryEntry(`parallelplay-sdk-${VERSION}/LICENSE`, readFileSync(resolve("LICENSE"))),
      ...packageArtifacts.map((artifact) =>
        memoryEntry(
          `parallelplay-sdk-${VERSION}/packages/${artifact.name}`,
          readFileSync(artifact.path)
        )
      )
    ]);
    primaryArtifacts.push(sdkArtifact);
    componentInventory.set(
      sdkArtifact.name,
      [
        ...new Map(
          packageArtifacts
            .flatMap((artifact) => componentInventory.get(artifact.name) ?? [])
            .map((entry) => [entry.identity, entry])
        ).values()
      ].sort((left, right) => left.identity.localeCompare(right.identity))
    );

    const platform = releasePlatform();
    const cliPrefix = `parallelplay-${VERSION}`;
    const runtimeTree = runtimePackageTree(resolve("apps/cli"), cliPrefix);
    const cliEntries = [
      memoryEntry(`${cliPrefix}/LICENSE`, readFileSync(resolve("LICENSE"))),
      memoryEntry(`${cliPrefix}/README.md`, readFileSync(resolve("README.md"))),
      memoryEntry(
        `${cliPrefix}/bin/parallelplay`,
        '#!/bin/sh\nset -eu\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec node "$DIR/dist/main.js" "$@"\n',
        0o755
      ),
      ...runtimeTree.entries
    ];
    const cliArtifact = writeArchive(
      output,
      `parallelplay-cli-${VERSION}-${platform}.tar.gz`,
      cliEntries
    );
    primaryArtifacts.push(cliArtifact);
    componentInventory.set(cliArtifact.name, runtimeTree.licenses);

    const sourceArtifact = writeArchive(
      output,
      `parallelplay-${VERSION}-source.tar.gz`,
      sourceEntries()
    );
    primaryArtifacts.push(sourceArtifact);
    componentInventory.set(sourceArtifact.name, packageDependencyInventory(resolve("apps/cli")));

    const fixtureManifestPath = resolve("fixtures/parallelplay-fixture-manifest.json");
    const fixtureManifest = readFileSync(fixtureManifestPath);
    const siblingFixtureManifest = resolve("../parallelplay-fixture/fixture/manifest.json");
    if (
      existsSync(siblingFixtureManifest) &&
      !readFileSync(siblingFixtureManifest).equals(fixtureManifest)
    ) {
      throw new Error(
        "The vendored fixture release manifest does not match the sibling fixture repository"
      );
    }
    writeFileSync(join(output, "fixture-manifest.json"), fixtureManifest);

    const suiteManifest = {
      schemaVersion: 1,
      suiteVersion: VERSION,
      contracts: [
        "agent-driver-v1",
        "workflow-extension-v1",
        "evaluator-extension-v1",
        "policy-extension-v1",
        "outbound-adapter-v1"
      ],
      failureClasses: [
        "retryable",
        "terminal",
        "authority-requiring",
        "protocol-invalid",
        "reject-without-external-effect"
      ],
      sourceDigest: sha256(readFileSync(resolve("packages/conformance/src/index.ts")))
    };
    writeFileSync(join(output, "conformance-suite.json"), `${canonical(suiteManifest)}\n`);

    for (const artifact of primaryArtifacts) {
      writeFileSync(
        join(output, `${artifact.name}.spdx.json`),
        `${canonical(spdxFor(artifact, componentInventory.get(artifact.name) ?? []))}\n`
      );
    }
    const licenses = [
      ...new Map(
        [...componentInventory.values()].flat().map((entry) => [entry.identity, entry])
      ).values()
    ].sort((left, right) => left.identity.localeCompare(right.identity));
    if (
      licenses.some(
        (entry) => entry.license === "UNKNOWN" || /UNLICENSED|PROPRIETARY/i.test(entry.license)
      )
    ) {
      throw new Error("Release dependency has an unknown or unexpected license");
    }
    writeFileSync(
      join(output, "license-inventory.json"),
      `${canonical({ schemaVersion: 1, generatedAt: new Date(epoch * 1000).toISOString(), packages: licenses })}\n`
    );
    const buildManifest = {
      schemaVersion: 1,
      version: VERSION,
      sourceDateEpoch: epoch,
      node: "22.17.1+",
      pnpm: "11.19.0",
      platform,
      artifacts: primaryArtifacts.map(({ name, sha256: digest, size }) => ({
        name,
        sha256: digest,
        size
      }))
    };
    writeFileSync(join(output, "build-manifest.json"), `${canonical(buildManifest)}\n`);

    const files = readdirSync(output, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
      .map((entry) => entry.name)
      .sort();
    const checksums = files
      .map((name) => `${sha256(readFileSync(join(output, name)))}  ${name}`)
      .join("\n");
    writeFileSync(join(output, "SHA256SUMS"), `${checksums}\n`);
    return { output, platform, files: [...files, "SHA256SUMS"].sort() };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const index = process.argv.indexOf("--output");
  const output =
    index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : ".parallelplay-release/final";
  process.stdout.write(`${JSON.stringify(buildRelease(output))}\n`);
}
