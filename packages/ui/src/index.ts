export interface ExtensionConformanceViewV1 {
  id: string;
  displayName: string;
  extensionVersion: string;
  kind: "driver" | "workflow" | "evaluator" | "policy" | "adapter";
  artifactDigest: string;
  conformance: {
    status: "passed" | "failed" | "not_run";
    reportDigest: string | null;
  };
  compatibility: {
    status: "approved" | "proposed" | "unregistered" | "suspended";
    registryDigest: string | null;
  };
}

export interface AppShellOptions {
  surface: "attention" | "explorer";
  title: string;
  documentTitle?: string;
  eyebrow: string;
  description: string;
  main: string;
  scriptPath: string;
  peer?: { label: string; url: string };
  extensions?: readonly ExtensionConformanceViewV1[];
}

const DIGEST = /^[a-f0-9]{64}$/;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function validateExtension(extension: ExtensionConformanceViewV1): void {
  if (!/^[a-z][a-z0-9._-]{0,99}$/.test(extension.id)) throw new Error("Invalid extension id");
  if (!DIGEST.test(extension.artifactDigest)) throw new Error("Invalid extension artifact digest");
  for (const digest of [
    extension.conformance.reportDigest,
    extension.compatibility.registryDigest
  ]) {
    if (digest !== null && !DIGEST.test(digest))
      throw new Error("Invalid extension evidence digest");
  }
}

export function renderExtensionConformanceView(
  extensions: readonly ExtensionConformanceViewV1[]
): string {
  if (extensions.length === 0) {
    return '<section class="shared-section" aria-labelledby="extensions-heading"><h2 id="extensions-heading">Extensions and conformance</h2><p class="empty-state">No release-bound extension evidence is loaded.</p></section>';
  }
  const cards = [...extensions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((extension) => {
      validateExtension(extension);
      return `<article class="extension-card"><header><div><h3>${escapeHtml(extension.displayName)}</h3><p class="muted">${escapeHtml(extension.id)} · ${escapeHtml(extension.kind)} · ${escapeHtml(extension.extensionVersion)}</p></div><span class="badge status-${escapeHtml(extension.conformance.status)}">${escapeHtml(extension.conformance.status)}</span></header><dl><div><dt>Artifact</dt><dd><code>${extension.artifactDigest}</code></dd></div><div><dt>Conformance report</dt><dd><code>${escapeHtml(extension.conformance.reportDigest ?? "not available")}</code></dd></div><div><dt>Compatibility</dt><dd>${escapeHtml(extension.compatibility.status)}</dd></div></dl></article>`;
    })
    .join("");
  return `<section class="shared-section" aria-labelledby="extensions-heading"><h2 id="extensions-heading">Extensions and conformance</h2><div class="extension-grid">${cards}</div></section>`;
}

export function renderAppShell(options: AppShellOptions): string {
  const peer = options.peer
    ? `<a class="surface-link" href="${escapeHtml(validateLoopbackNavigation(options.peer.url))}">${escapeHtml(options.peer.label)}</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(options.documentTitle ?? options.title)}</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body data-surface="${options.surface}">
  <header class="site-shell"><div><p class="eyebrow">${escapeHtml(options.eyebrow)}</p><h1>${escapeHtml(options.title)}</h1><p class="shell-description">${escapeHtml(options.description)}</p></div><nav aria-label="ParallelPlay surfaces">${peer}</nav><p class="connection"><span class="connection-dot" aria-hidden="true"></span><span id="identity">Local connection</span></p></header>
  <main>${options.main}${renderExtensionConformanceView(options.extensions ?? [])}</main>
  <script type="module" src="${escapeHtml(options.scriptPath)}"></script>
</body>
</html>`;
}

export function validateLoopbackNavigation(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username ||
    url.password
  ) {
    throw new Error("UI navigation must be a credential-free loopback URL");
  }
  const allowed = new Set(["packet", "revision"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new Error("UI navigation contains a non-identity parameter");
  }
  return url.href;
}

export const SHARED_STYLES = `
:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; --bg: #0d1117; --panel: #151b24; --panel-strong: #0f141c; --border: #394456; --text: #eef2f8; --muted: #aab6c8; --link: #91caff; --focus: #ffd166; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.site-shell, main { max-width: 76rem; margin: 0 auto; padding: 1.5rem; }
.site-shell { border-bottom: 1px solid var(--border); display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: end; }
.site-shell h1 { font-size: clamp(2rem, 7vw, 4rem); margin: 0; }
.shell-description { color: var(--muted); max-width: 70ch; }
.eyebrow, .muted { color: var(--muted); }
.eyebrow { text-transform: uppercase; letter-spacing: .12em; font-weight: 700; }
.surface-link { color: var(--link); font-weight: 700; }
.connection { grid-column: 1 / -1; color: var(--muted); margin: 0; }
.connection-dot { display: inline-block; width: .6rem; height: .6rem; border-radius: 50%; background: #83e6a5; margin-right: .45rem; }
.shared-section { border-top: 1px solid var(--border); margin-top: 2.5rem; padding-top: 1rem; }
.extension-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1rem; }
.extension-card { border: 1px solid var(--border); border-radius: .8rem; background: var(--panel); padding: 1rem; min-width: 0; }
.extension-card header { display: flex; justify-content: space-between; gap: 1rem; padding: 0; border: 0; }
.extension-card h3 { margin: 0; }
.extension-card dl { display: grid; gap: .7rem; }
.extension-card dt { color: var(--muted); font-size: .85rem; }
.extension-card dd { margin: 0; overflow-wrap: anywhere; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: .2rem .6rem; height: fit-content; }
.status-passed, .status-approved { color: #83e6a5; }
.status-failed, .status-suspended { color: #ffb39f; }
.status-not_run, .status-proposed { color: #ffd166; }
.empty-state { padding: 2rem; border: 1px dashed #56617a; border-radius: .75rem; }
:focus-visible { outline: .2rem solid var(--focus); outline-offset: .2rem; }
@media (max-width: 48rem) { .site-shell { grid-template-columns: 1fr; } .connection { grid-column: 1; } }
`;
