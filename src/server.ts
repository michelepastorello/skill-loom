import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  realpathSync,
  statSync,
  readdirSync,
  existsSync,
  createReadStream,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  saveConfig,
  expandTilde,
  resolveConsumers,
  validateLint,
  resolveAxes,
  CONFIG_NAME,
  type LoomConfig,
  type LintConfig,
  type TaxonomyAxis,
} from "./config.js";
import { rulesImpact } from "./gate.js";
import { zip, type ZipEntry } from "./zip.js";
/** Ceiling for one export. A skill folder is kilobytes; anything past this is
 *  either a mistake or a job for the vault directory itself, and the whole
 *  archive is built in memory before it is sent. */
const EXPORT_LIMIT = 64 * 1024 * 1024;
import { isLocalHost } from "./commands/ui.js";

/** Whether a caller at `peer` may use the sync `force` escape hatch.
 *
 *  Extracted so the decision is testable without binding a non-loopback
 *  interface. IPv4-mapped IPv6 peers ("::ffff:127.0.0.1") are what Node hands
 *  back on a dual-stack listener, so the prefix is stripped before the check —
 *  miss that and every local caller looks remote. */
export function forceSyncAllowed(peer: string): boolean {
  return isLocalHost((peer ?? "").replace(/^::ffff:/, ""));
}
import { setServed } from "./inplace.js";
import { commitsBehindHead, readGraphFreshness } from "./freshness.js";
import { readVaultGraph } from "./graph.js";
import {
  listSources,
  listSourceSkills,
  sourceDir,
  sourceSkillDir,
  type Source,
} from "./sources.js";
import {
  scanVault,
  validateVault,
  skillWarnings,
  parseFrontmatterField,
  parseFrontmatterName,
  parseFirstH1,
  isLinked,
  ARCHIVE_DIR,
  NAME_RE,
  type Skill,
} from "./vault.js";
import {
  orphanAgentLinks,
  orphanLinks,
  planAgentLinks,
  planLinks,
  planOrphanLinks,
  applyPlan,
  statusMatrix,
  setSkillLinks,
  setSkillEverywhere,
  type LinkState,
} from "./linker.js";
import {
  addOp,
  archiveOp,
  bulkArchiveOp,
  bulkRestoreOp,
  bulkStatusOp,
  bulkTaxonomyOp,
  restoreOp,
  type OpOutcome,
} from "./ops.js";
import { syncOp, syncStatus, syncFiles, setRemote, vaultRepo } from "./sync.js";
import { PRESETS } from "./commands/init.js";
import { UsageError } from "./errors.js";

// Title-case a skill slug, keeping common tech acronyms and proper nouns cased.
// prettier-ignore
const ACRONYMS = new Set([
  "ai", "ml", "llm", "api", "sdk", "cli", "ui", "ux", "css", "html", "xml",
  "json", "yaml", "toml", "csv", "svg", "pdf", "url", "uri", "http", "https",
  "sql", "db", "orm", "ci", "cd", "os", "ip", "dns", "ssh", "tls", "ssl",
  "jwt", "oauth", "uuid", "id", "qa", "mcp", "cdn", "crud", "dto", "seo",
  "aws", "gcp", "cpu", "gpu", "ram", "io", "faq", "vps", "3d", "2d",
  "gpt", "tts", "crm", "ynab", "nas", "pptx", "en", "it", "pmf", "smb",
  "docx", "md", "mcpb", "cv",
]);
const PROPER: Record<string, string> = {
  linkedin: "LinkedIn",
  openai: "OpenAI",
  openclaw: "OpenClaw",
  github: "GitHub",
  posthog: "PostHog",
  heygen: "HeyGen",
  macos: "macOS",
  opencode: "OpenCode",
  npm: "npm",
  noteplan: "NotePlan",
  brandkit: "BrandKit",
  hyperframes: "HyperFrames",
  fal: "fal",
};
const MINOR = new Set([
  "to",
  "of",
  "and",
  "the",
  "for",
  "in",
  "on",
  "a",
  "an",
  "with",
  "by",
  "vs",
  "or",
  "at",
]);

export function humanizeName(
  name: string,
  names: Record<string, string> = {},
): string {
  return name
    .split("-")
    .map((w, i) => {
      const lw = w.toLowerCase();
      if (names[lw] !== undefined) return names[lw];
      if (PROPER[lw]) return PROPER[lw];
      if (ACRONYMS.has(lw)) return lw.toUpperCase();
      if (i > 0 && MINOR.has(lw)) return lw;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** Sources as the client reads them. The rail needs each group's size, not its
 *  contents: the names ride on /api/source-skills, where the list is rendered.
 *  Labels are humanized here and only here — the key stays the machine-readable
 *  thing that addresses the group. */
export interface WireGroup {
  key: string;
  label: string;
  count: number;
}
export interface WireSource extends Omit<Source, "groups"> {
  groups: WireGroup[];
}
export function wireSources(
  sources: Source[],
  names: Record<string, string>,
): WireSource[] {
  return sources.map((s) => ({
    ...s,
    groups: s.groups.map((g) => ({
      key: g.key,
      label: humanizeName(g.label, names),
      count: g.skills.length,
    })),
  }));
}

// Word-casing map for the client (rail labels, chips): built-ins merged with
// the vault's custom `names` from loom.json, which always wins.
export function clientNames(
  custom: Record<string, string>,
): Record<string, string> {
  return {
    ...Object.fromEntries([...ACRONYMS].map((a) => [a, a.toUpperCase()])),
    ...PROPER,
    ...custom,
  };
}

export function aggregateHealth(
  all: LinkState[],
): "active" | "attention" | "inactive" {
  // "served" (in-place, read straight from the vault) is as healthy as "linked".
  const healthy = (s: LinkState) => s === "linked" || s === "served";
  // An overridden pair is not a measurement of anything: the runtime owns that
  // name (external) or is meant not to have it (disabled). Counting it would
  // make a skill correctly projected into six runtimes read as "partial"
  // forever because of the seventh, which is the report the override exists to
  // stop. A skill with nothing BUT overrides has no projection to grade, and
  // falls through to "inactive".
  const states = all.filter((s) => s !== "external" && s !== "disabled");
  if (states.some((s) => s === "broken" || s === "foreign")) return "attention";
  if (states.length > 0 && states.every(healthy)) return "active";
  if (states.some(healthy)) return "attention";
  return "inactive";
}

// Vault-root governance docs surfaced (read-only) in the dashboard's Rules
// view. A fixed whitelist doubles as the path guard for GET /api/doc.
const GOVERNANCE_DOCS = ["CONVENTIONS.md", "README.md", "source-registry.yaml"];

/** Frontmatter values for every declared axis, spread flat onto the skill
 *  object so the client can read s[axisId] without knowing any axis name. */
function axisFields(
  md: string,
  axes: TaxonomyAxis[],
): Record<string, string | null> {
  return Object.fromEntries(
    axes.map((a) => [a.id, parseFrontmatterField(md, a.id) ?? null]),
  );
}

// Archived skills come from the real archive/ folder (the source of truth) —
// loom.json's `archived` list only adds date/reason metadata when present, so
// a skill moved into archive/ by hand still shows up.
function scanArchived(vaultDir: string, cfg: LoomConfig) {
  const dir = path.join(vaultDir, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  const axes = resolveAxes(cfg);
  // The .archive/ folder is the single source of truth: archiving is a pure
  // move, so everything is read from the file. Date approximates from mtime.
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(path.join(dir, e.name, "SKILL.md")),
    )
    .map((e) => {
      const md = path.join(dir, e.name, "SKILL.md");
      const st = statSync(md, { throwIfNoEntry: false });
      return {
        name: e.name,
        title: humanizeName(e.name, cfg.names),
        description: parseFrontmatterField(md, "description") ?? "",
        icon: parseFrontmatterField(md, "icon") ?? null,
        iconColor: parseFrontmatterField(md, "icon-color") ?? null,
        ...axisFields(md, axes),
        status: parseFrontmatterField(md, "status") ?? "active",
        date: st ? st.mtime.toISOString().slice(0, 10) : "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildState(vaultDir: string): object {
  const cfg = loadConfig(vaultDir);
  const axes = resolveAxes(cfg);
  const skills = scanVault(vaultDir, cfg);
  const matrix = statusMatrix(skills, cfg, vaultDir);
  // Per-skill git state: does anything under the skill's folder still need
  // a commit, a push, or a pull? Priority: dirty > ahead > behind > clean.
  const sf = syncFiles(vaultDir);
  const syncOf = (rel: string): "dirty" | "ahead" | "behind" | "clean" => {
    const hit = (arr: string[]) =>
      arr.some((f) => f === rel || f.startsWith(rel + "/"));
    if (hit(sf.dirty)) return "dirty";
    if (hit(sf.outgoing)) return "ahead";
    if (hit(sf.incoming)) return "behind";
    return "clean";
  };
  return {
    vaultDir,
    consumers: cfg.consumers,
    archived: scanArchived(vaultDir, cfg),
    names: clientNames(cfg.names),
    customNames: cfg.names,
    // The vault's declared taxonomy axes (Task 1's resolveAxes) — the client
    // reads this to render per-axis columns/filters without hardcoding
    // domain/layer.
    axes: axes.map((a) => ({
      id: a.id,
      label: a.label ?? null,
      values: a.values ?? [],
      hues: a.hues ?? null,
      tile: a.tile === true,
    })),
    // Known runtimes detected on this machine but not configured yet — the
    // Settings page offers them as one-click additions.
    presets: Object.entries(PRESETS)
      .filter(
        ([n, p]) =>
          !cfg.consumers[n] &&
          !Object.values(cfg.consumers).includes(p) &&
          existsSync(path.dirname(expandTilde(p))),
      )
      .map(([name, p]) => ({ name, path: p })),
    skills: skills.map((s) => {
      const md = path.join(s.dir, "SKILL.md");
      const st = statSync(md, { throwIfNoEntry: false });
      const states = matrix
        .filter((m) => m.skill === s.name)
        .map((m) => m.state);
      return {
        name: s.name,
        title: humanizeName(s.name, cfg.names),
        health: aggregateHealth(states),
        dir: s.dir,
        rel: path.relative(vaultDir, s.dir),
        icon: parseFrontmatterField(md, "icon") ?? null,
        iconColor: parseFrontmatterField(md, "icon-color") ?? null,
        ...axisFields(md, axes),
        status: parseFrontmatterField(md, "status") ?? "active",
        sync: syncOf(path.relative(vaultDir, s.dir)),
        description: parseFrontmatterField(md, "description") ?? "",
        modified: st ? st.mtime.toISOString().slice(0, 10) : "",
      };
    }),
    problems: validateVault(skills),
    warnings: skillWarnings(skills, cfg),
    matrix,
    orphans: [
      ...orphanLinks(vaultDir, cfg, skills),
      ...orphanAgentLinks(vaultDir, cfg, skills),
    ],
    docs: GOVERNANCE_DOCS.filter((n) => existsSync(path.join(vaultDir, n))).map(
      (name) => ({ name, kind: fileKind(name) }),
    ),
    // What the New skill form needs to make a skill born gate-ready: which
    // taxonomy the vault requires, the allowed values, required sections and
    // the description length floor. Null when the vault has no lint block.
    lint: cfg.lint
      ? {
          requireTaxonomy: cfg.lint.requireTaxonomy ?? [],
          requireSections: cfg.lint.requireSections ?? [],
          allowedDomains: cfg.lint.allowedDomains ?? [],
          allowedLayers: cfg.lint.allowedLayers ?? [],
          // Additive alongside the two legacy keys above, which stay for good:
          // the Config → Rules editor (src/ui.js) edits allowedDomains/
          // allowedLayers as the lint block's own editable content, not as a
          // stand-in for the New-skill form (that reads allowedByAxis).
          allowedByAxis: Object.fromEntries(
            axes.map((a) => [a.id, a.values ?? []]),
          ),
          descriptionMinChars: cfg.lint.descriptionMinChars ?? null,
          descriptionMaxChars: cfg.lint.descriptionMaxChars ?? null,
          bodyMaxLines: cfg.lint.bodyMaxLines ?? null,
          forbidBodyPatterns: cfg.lint.forbidBodyPatterns ?? [],
          strict: cfg.lint.strict === true,
        }
      : null,
  };
}

export function gitDiff(
  vaultDir: string,
): { versioned: false } | { versioned: true; status: string; diff: string } {
  // Guard: only report changes when the vault is its own repo root. Otherwise a
  // vault nested in a larger repo (e.g. the home dir) would list every unrelated
  // file as an "unsaved change".
  if (!vaultRepo(vaultDir).isRoot) return { versioned: false };
  const status = spawnSync("git", ["-C", vaultDir, "status", "--porcelain"], {
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) return { versioned: false };
  const diff = spawnSync("git", ["-C", vaultDir, "diff"], { encoding: "utf8" });
  return {
    versioned: true,
    status: status.stdout,
    diff: diff.status === 0 ? diff.stdout : "",
  };
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

const HTTP_BY_STATUS: Record<OpOutcome["status"], number> = {
  0: 200,
  1: 409,
  2: 400,
};

function sendOp(res: ServerResponse, out: OpOutcome, apply: boolean): void {
  sendJson(res, HTTP_BY_STATUS[out.status], {
    applied: apply && out.status === 0,
    ...out,
  });
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new UsageError("content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new UsageError("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("invalid JSON body");
  }
  // Every POST handler reads body.<field>; a valid-JSON non-object (null, an
  // array, a primitive) would slip past the cast and crash at first access.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

// A non-empty array of non-empty strings, else undefined (rejected by routes).
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  if (!v.every((x) => typeof x === "string" && x.length > 0)) return undefined;
  return v as string[];
}

// POST /api/add's per-axis taxonomy map. Prefers the generic `taxonomy`
// object, then additively folds in the legacy top-level `domain`/`layer`
// fields for backward compatibility — src/ui.js's New-skill form no longer
// posts those (it posts `taxonomy` directly, see doAdd), but external
// callers built against the pre-axes API still do. The fold is guarded on
// the axis actually existing in `axisIds`: on a vault that declared away
// domain/layer (e.g. domain/area/kind), folding an unrecognised `layer` in
// unconditionally would make addOp reject the request outright — 0.4.0
// created the skill in that case, so the shim must only fire for axes this
// vault still has. A key already present in the posted `taxonomy` map wins
// over its legacy counterpart.
function taxonomyFromAddBody(
  body: Record<string, unknown>,
  axisIds: string[],
): Record<string, string> {
  const map = Object.fromEntries(
    Object.entries((body.taxonomy ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, str(v)])
      .filter(([, v]) => v),
  ) as Record<string, string>;
  if (axisIds.includes("domain") && !("domain" in map) && str(body.domain))
    map.domain = str(body.domain)!;
  if (axisIds.includes("layer") && !("layer" in map) && str(body.layer))
    map.layer = str(body.layer)!;
  return map;
}

// gzip is computed once per file version and kept in memory: icons.js alone is
// 400KB, and compressing it on every request would trade the bandwidth win for
// CPU. Keyed by mtime, so editing an asset invalidates the entry — the UI is
// served straight off disk on purpose (edit, reload, see it), and a cache that
// outlived the file would break exactly that.
const gzCache = new Map<string, { mtimeMs: number; body: Buffer }>();
function gzipFor(assetPath: string, raw: string): Buffer {
  const { mtimeMs } = statSync(assetPath);
  const hit = gzCache.get(assetPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.body;
  const body = gzipSync(Buffer.from(raw, "utf8"));
  gzCache.set(assetPath, { mtimeMs, body });
  return body;
}

// The UI ships as sibling files next to the compiled server (ui.html + ui.css +
// ui.js + icons.js); serve each with its own content-type, gzipped when the
// client says it can take it. Uncompressed the four total ~810KB, which is free
// on localhost and is not over Tailscale from a phone.
function serveAsset(
  res: ServerResponse,
  file: string,
  mime: string,
  req?: IncomingMessage,
): void {
  const assetPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    file,
  );
  const raw = readFileSync(assetPath, "utf8");
  // The bundle carries no hash in its name and the server sent no validator at
  // all, so a browser was free to decide for itself how long ui.js stays
  // fresh — and it does, which means a rebuilt dashboard could keep serving
  // the previous one until a hard reload. The files are read from disk on
  // every request anyway; asking for revalidation costs a round trip on a
  // loopback/Tailscale host and removes a class of "I already fixed that".
  const headers = { "cache-control": "no-cache" };
  const accepts = String(req?.headers["accept-encoding"] || "").includes(
    "gzip",
  );
  if (!accepts) {
    res.writeHead(200, { ...headers, "content-type": mime });
    res.end(raw);
    return;
  }
  const body = gzipFor(assetPath, raw);
  res.writeHead(200, {
    ...headers,
    "content-type": mime,
    "content-encoding": "gzip",
    "content-length": body.length,
    vary: "accept-encoding",
  });
  res.end(body);
}
function serveHtml(res: ServerResponse, req?: IncomingMessage): void {
  serveAsset(res, "ui.html", "text/html; charset=utf-8", req);
}

// Instance branding. serveAsset() reads utf8, which mangles binary; these are
// read as buffers. A --brand-dir file of the same name wins over the bundled
// default, so two instances of the same vault (laptop + server) can be told
// apart in a tab strip without forking the asset into the package.
const BRAND_ASSETS: Record<string, string> = {
  "favicon.ico": "image/x-icon",
  "favicon-32.png": "image/png",
  "favicon-16.png": "image/png",
  "apple-touch-icon.png": "image/png",
};
function serveBrandAsset(
  res: ServerResponse,
  file: string,
  brandDir?: string,
): void {
  const override = brandDir ? path.join(expandTilde(brandDir), file) : "";
  const assetPath =
    override && existsSync(override)
      ? override
      : path.join(path.dirname(fileURLToPath(import.meta.url)), file);
  res.writeHead(200, { "content-type": BRAND_ASSETS[file] });
  res.end(readFileSync(assetPath));
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};
const TEXT_EXT = new Set([
  "",
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".py",
  ".php",
  ".sh",
  ".bash",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".json",
  // Line-delimited siblings of the formats above: a log of runs, an export, a
  // table. They are text a reader opens for the same reason a .json is.
  ".jsonl",
  ".ndjson",
  ".jsonc",
  ".tsv",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".html",
  ".csv",
  ".xml",
  ".cfg",
  ".ini",
]);

function fileKind(name: string): "text" | "image" | "binary" {
  const ext = path.extname(name).toLowerCase();
  if (ext in IMAGE_MIME) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "binary";
}

// Paths under `dir` that git ignores, relative to it. Caches and build output
// (__pycache__, .pytest_cache, .venv) are not part of a skill, and the vault's
// .gitignore already says so — the viewer reads that answer instead of keeping
// a denylist of its own. Untracked-but-not-ignored files stay visible: those
// are unsaved work, which the dashboard exists to surface. Outside a git repo
// the command fails and nothing is hidden.
function gitIgnoredPaths(dir: string): Set<string> {
  const r = spawnSync(
    "git",
    ["-C", dir, "ls-files", "-o", "-i", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  );
  if (r.status !== 0 || !r.stdout) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}

function listSkillFiles(
  skillDir: string,
): { path: string; size: number; kind: "text" | "image" | "binary" }[] {
  const out: {
    path: string;
    size: number;
    kind: "text" | "image" | "binary";
  }[] = [];
  const ignored = gitIgnoredPaths(skillDir);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(skillDir, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && !ignored.has(rel))
        out.push({
          path: rel,
          size: statSync(full).size,
          kind: fileKind(entry.name),
        });
    }
  };
  walk(skillDir);
  return out.sort((a, b) =>
    a.path === "SKILL.md"
      ? -1
      : b.path === "SKILL.md"
        ? 1
        : a.path.localeCompare(b.path),
  );
}

// Resolve `?src=<id>&group=<key>&name=<skill>` to an absolute skill dir inside
// that read-only source, or null. The group is part of the key because one name
// can exist in two groups (two plugins both shipping `runbook`). NAME_RE rejects
// `..`/`/`, and sourceSkillDir only ever returns a skill its group really holds,
// so an arbitrary path can never be read.
function resolveSourceSkillDir(
  url: URL,
  vaultDir: string,
  cfg: LoomConfig,
): string | null {
  const src = url.searchParams.get("src") ?? "";
  const group = url.searchParams.get("group") ?? "";
  const name = url.searchParams.get("name") ?? "";
  if (!src || !NAME_RE.test(name)) return null;
  const dir = sourceSkillDir(src, group, name, vaultDir, cfg);
  if (!dir) return null;
  if (!existsSync(path.join(dir, "SKILL.md"))) return null;
  return dir;
}

function findSkill(vaultDir: string, name: string | null): Skill | undefined {
  // Reject anything that isn't a valid skill name before it reaches a path
  // join — otherwise a `..`-laden name escapes the vault via the archive
  // fallback below (GET /api/skill and /api/file both resolve through here).
  if (!name || !NAME_RE.test(name)) return undefined;
  const active = scanVault(vaultDir, loadConfig(vaultDir)).find(
    (s) => s.name === name,
  );
  if (active) return active;
  // fall back to the archive so archived skills are browsable too
  const dir = path.join(vaultDir, ARCHIVE_DIR, name);
  const md = path.join(dir, "SKILL.md");
  if (existsSync(md))
    return {
      name,
      dir,
      frontmatterName: parseFrontmatterName(md),
      firstH1: parseFirstH1(md),
    };
  return undefined;
}

/** Every file under a skill folder, as archive entries under `prefix`.
 *
 *  Empty directories are dropped: the format can carry them and no extractor
 *  needs them, since parents are created from the file paths. A symlink to a
 *  file is followed and its content copied — that is what "give me this skill"
 *  means — but only while it resolves inside the skill folder, the same
 *  containment GET /api/file applies: a link to ~/.ssh or to another skill is
 *  left out of the archive instead of being handed over the network. A symlink
 *  to a directory is skipped rather than walked into a possible loop. */
function collectFiles(
  dir: string,
  prefix: string,
  out: ZipEntry[],
  budget: { left: number },
  root: string = realpathSync(dir),
): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      collectFiles(abs, rel, out, budget, root);
      continue;
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      continue; // a dangling link has nothing to copy
    }
    if (!real.startsWith(root + path.sep)) continue;
    const st = statSync(real, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    if (st.size > budget.left)
      throw new UsageError(
        "that is more than the export limit; take it from the vault directly",
      );
    budget.left -= st.size;
    out.push({ path: rel, data: readFileSync(real), mtime: st.mtime });
  }
}

function isArchivedSkill(vaultDir: string, skill: Skill): boolean {
  return path.dirname(skill.dir) === path.join(vaultDir, ARCHIVE_DIR);
}

/** Resolve an optional in-skill file path into an absolute git pathspec, guarding
 *  against escaping the skill directory (same guard as GET /api/file). No path →
 *  the whole skill dir; escaping path → null (caller returns 400). */
function scopedTarget(skillDir: string, rel: string | null): string | null {
  if (!rel) return skillDir;
  const skillReal = realpathSync(skillDir);
  let real: string;
  try {
    real = realpathSync(path.join(skillDir, rel));
  } catch {
    return null;
  }
  return real === skillReal || real.startsWith(skillReal + path.sep)
    ? real
    : null;
}

/** Resolve `?name=&path=` against the vault into one readable file, or the
 *  reason it is not one. GET /api/file and GET /api/file-raw share it so the
 *  viewer and the bytes behind it can never disagree on what may be read. */
function resolveVaultFile(
  vaultDir: string,
  url: URL,
):
  | { ok: true; real: string; name: string; rel: string }
  | { ok: false; code: number; error: string } {
  const name = url.searchParams.get("name");
  const skill = findSkill(vaultDir, name);
  if (!skill) return { ok: false, code: 404, error: "skill not found" };
  const rel = url.searchParams.get("path") ?? "";
  let real: string;
  try {
    real = realpathSync(path.join(skill.dir, rel));
  } catch {
    return { ok: false, code: 404, error: "file not found" };
  }
  const skillReal = realpathSync(skill.dir);
  if (real !== skillReal && !real.startsWith(skillReal + path.sep))
    return { ok: false, code: 400, error: "path escapes skill directory" };
  if (!statSync(real).isFile())
    return { ok: false, code: 400, error: "not a file" };
  return { ok: true, real, name: name ?? "", rel };
}

/** Send an image as its own bytes. This route exists so a multi-MB photo can be
 *  shown at all: base64 in the JSON costs a third more and buffers the whole
 *  file, so the viewer gets a URL and the browser streams it.
 *
 *  Images only — the point is to view an asset, not to hand out an HTTP read of
 *  any file under a skill. The vault is edited live, so a replaced asset has to
 *  win on reload; and an SVG opened straight in a tab must stay inert. */
function sendImage(res: ServerResponse, real: string): void {
  if (fileKind(real) !== "image")
    return sendJson(res, 400, { error: "not an image" });
  streamFile(res, real, {
    // Non-null: fileKind said "image" off this very table.
    "content-type": IMAGE_MIME[path.extname(real).toLowerCase()],
    // An SVG opened straight in a tab must stay inert.
    "content-security-policy": "default-src 'none'; sandbox",
  });
}

/** Hand one file over as a download. Exporting a skill produces a zip because a
 *  folder has to become a file first; a single file already is one, so it
 *  travels as itself — the photo opens in an image viewer, not out of an
 *  archive that has to be unpacked and then thrown away.
 *
 *  No CSP here, unlike the image route: `attachment` means the browser saves
 *  the file instead of rendering it, so there is no document to sandbox. */
function sendDownload(res: ServerResponse, real: string, rel: string): void {
  streamFile(res, real, {
    // The browser saves rather than renders, so the type is only a hint to the
    // OS about what to open it with.
    "content-type":
      IMAGE_MIME[path.extname(real).toLowerCase()] ??
      "application/octet-stream",
    "content-disposition": contentDisposition(rel),
  });
}

/** `content-disposition` for a downloaded file. A vault path may hold accents
 *  or spaces, which a bare `filename=` cannot carry, so the UTF-8 form rides
 *  alongside an ASCII fallback. Quotes and newlines are dropped rather than
 *  escaped: no vault file needs them, and a header split does. */
function contentDisposition(rel: string): string {
  const base = path.basename(rel).replace(/[\r\n"\\]/g, "") || "file";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

/** Send a file as bytes, streamed. Shared by the two things that hand a file
 *  over whole — the image the viewer shows and the file it exports — so both
 *  answer 404 to a file that vanished between being listed and being read, and
 *  both drop the socket on a read that dies after the headers are out (there is
 *  no error page left to send, and a stalled response is worse than a truncated
 *  one). Never cached: the vault is edited live, so a replaced file has to win
 *  on the next reload. */
function streamFile(
  res: ServerResponse,
  real: string,
  headers: Record<string, string>,
): void {
  let size: number;
  try {
    const st = statSync(real);
    if (!st.isFile()) return sendJson(res, 400, { error: "not a file" });
    size = st.size;
  } catch {
    return sendJson(res, 404, { error: "file not found" });
  }
  res.writeHead(200, {
    "content-length": size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  const stream = createReadStream(real);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

export function createUiServer(
  vaultDir: string,
  opts: { brandDir?: string } = {},
): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /") return serveHtml(res, req);
      if (route === "GET /ui.css")
        return serveAsset(res, "ui.css", "text/css; charset=utf-8", req);
      if (route === "GET /ui.js")
        return serveAsset(
          res,
          "ui.js",
          "application/javascript; charset=utf-8",
          req,
        );
      // Vendored at build (a devDependency copied into dist/src, not a runtime
      // dep) so it ships self-contained and offline; the UI lazy-loads it only
      // when a rendered doc actually holds a mermaid fence.
      if (route === "GET /mermaid.js")
        return serveAsset(
          res,
          "mermaid.min.js",
          "application/javascript; charset=utf-8",
          req,
        );
      if (req.method === "GET" && url.pathname.slice(1) in BRAND_ASSETS)
        return serveBrandAsset(res, url.pathname.slice(1), opts.brandDir);
      if (route === "GET /icons.js")
        return serveAsset(
          res,
          "icons.js",
          "application/javascript; charset=utf-8",
          req,
        );
      if (route === "GET /api/state")
        return sendJson(res, 200, buildState(vaultDir));
      if (route === "GET /api/diff")
        return sendJson(res, 200, gitDiff(vaultDir));
      if (route === "GET /api/graph-freshness")
        return sendJson(res, 200, readGraphFreshness(vaultDir));
      if (route === "GET /api/graph") {
        // The projection is skill-level on purpose: the raw graph is megabytes
        // of concept nodes, and the dashboard governs skills.
        const cfg = loadConfig(vaultDir);
        const names = scanVault(vaultDir, cfg).map((s) => s.name);
        return sendJson(
          res,
          200,
          readVaultGraph(vaultDir, names, (commit) =>
            commitsBehindHead(vaultDir, commit),
          ),
        );
      }
      if (route === "GET /api/doc") {
        // Read-only vault-root governance doc. The whitelist is the guard:
        // anything not in GOVERNANCE_DOCS (including traversal) is refused.
        const name = url.searchParams.get("name") ?? "";
        if (!GOVERNANCE_DOCS.includes(name))
          return sendJson(res, 400, { error: "not a governance doc" });
        const file = path.join(vaultDir, name);
        if (!existsSync(file))
          return sendJson(res, 404, { error: "doc not found" });
        return sendJson(res, 200, {
          name,
          kind: fileKind(name),
          content: readFileSync(file, "utf8"),
        });
      }
      if (route === "POST /api/link") {
        const body = await readBody(req);
        const apply = body.apply === true;
        const cfg = loadConfig(vaultDir);
        const skills = scanVault(vaultDir, cfg);
        const problems = validateVault(skills);
        if (problems.length > 0)
          return sendJson(res, 409, {
            error: "vault problems — fix before linking",
            problems,
          });
        const items = [
          ...planLinks(skills, cfg),
          ...planAgentLinks(skills, cfg),
          ...planOrphanLinks(vaultDir, cfg, skills),
        ];
        const conflicts = items.filter((i) => i.action === "conflict").length;
        if (apply) applyPlan(items);
        return sendJson(res, conflicts > 0 ? 409 : 200, {
          applied: apply,
          items,
          conflicts,
        });
      }
      if (route === "POST /api/add") {
        const body = await readBody(req);
        const axisIds = resolveAxes(loadConfig(vaultDir)).map((a) => a.id);
        return sendOp(
          res,
          addOp(
            vaultDir,
            str(body.name),
            {
              description: str(body.description),
              status: str(body.status),
              taxonomy: taxonomyFromAddBody(body, axisIds),
            },
            body.apply === true,
          ),
          body.apply === true,
        );
      }
      if (route === "POST /api/archive") {
        const body = await readBody(req);
        return sendOp(
          res,
          archiveOp(vaultDir, str(body.name), body.apply === true),
          body.apply === true,
        );
      }
      if (route === "GET /api/sources") {
        const cfg = loadConfig(vaultDir);
        return sendJson(res, 200, {
          sources: wireSources(listSources(vaultDir, cfg), cfg.names),
        });
      }
      if (route === "GET /api/source-skills") {
        const cfg = loadConfig(vaultDir);
        const src = url.searchParams.get("src") ?? "";
        if (!sourceDir(src, vaultDir, cfg))
          return sendJson(res, 404, { error: "unknown source" });
        return sendJson(res, 200, {
          skills: listSourceSkills(src, vaultDir, cfg).map((s) => ({
            ...s,
            title: humanizeName(s.name, cfg.names),
          })),
        });
      }
      if (route === "GET /api/source-skill") {
        const cfg = loadConfig(vaultDir);
        const dir = resolveSourceSkillDir(url, vaultDir, cfg);
        if (!dir) return sendJson(res, 404, { error: "not found" });
        const md = path.join(dir, "SKILL.md");
        return sendJson(res, 200, {
          name: path.basename(dir),
          title: humanizeName(path.basename(dir), cfg.names),
          description: parseFrontmatterField(md, "description") ?? "",
          frontmatter: (() => {
            try {
              const s = readFileSync(md, "utf8").replace(/\r\n/g, "\n");
              const m = /^---\n([\s\S]*?)\n---/.exec(s);
              return m ? m[1] : "";
            } catch {
              return "";
            }
          })(),
          files: listSkillFiles(dir),
        });
      }
      if (route === "GET /api/source-file") {
        const cfg = loadConfig(vaultDir);
        const dir = resolveSourceSkillDir(url, vaultDir, cfg);
        if (!dir) return sendJson(res, 404, { error: "not found" });
        const rel = url.searchParams.get("path") ?? "SKILL.md";
        // Only files the skill actually lists are readable (no path traversal).
        if (!listSkillFiles(dir).some((f) => f.path === rel))
          return sendJson(res, 400, { error: "bad path" });
        // Same shape as /api/file, so the viewer can highlight code and skip
        // binaries/images here exactly as it does for a vault skill.
        const real = path.join(dir, rel);
        try {
          const st = statSync(real);
          const kind = fileKind(real);
          // Same order as /api/file: an image answers with a URL, so its size
          // never runs into the JSON payload cap.
          if (kind === "image")
            return sendJson(res, 200, {
              path: rel,
              kind,
              size: st.size,
              src: `/api/source-file-raw?src=${encodeURIComponent(url.searchParams.get("src") ?? "")}&group=${encodeURIComponent(url.searchParams.get("group") ?? "")}&name=${encodeURIComponent(url.searchParams.get("name") ?? "")}&path=${encodeURIComponent(rel)}`,
            });
          if (st.size > 1024 * 1024 || kind === "binary")
            return sendJson(res, 200, {
              path: rel,
              kind: "binary",
              size: st.size,
            });
          return sendJson(res, 200, {
            path: rel,
            kind,
            size: st.size,
            content: readFileSync(real, "utf8"),
          });
        } catch {
          return sendJson(res, 404, { error: "unreadable" });
        }
      }
      if (
        route === "GET /api/source-file-raw" ||
        route === "GET /api/source-file-download"
      ) {
        const cfg = loadConfig(vaultDir);
        const dir = resolveSourceSkillDir(url, vaultDir, cfg);
        if (!dir) return sendJson(res, 404, { error: "not found" });
        const rel = url.searchParams.get("path") ?? "";
        // The listing is the guard here, exactly as in /api/source-file: only
        // a path the skill actually lists is readable.
        if (!listSkillFiles(dir).some((f) => f.path === rel))
          return sendJson(res, 400, { error: "bad path" });
        const real = path.join(dir, rel);
        return route.endsWith("-raw")
          ? sendImage(res, real)
          : sendDownload(res, real, rel);
      }
      if (route === "GET /api/export") {
        // A skill folder, handed over as one file. The vault is the source of
        // truth and stays where it is: this is a copy for a machine that does
        // not have it — an issue attachment, a colleague, a backup.
        const names = url.searchParams.getAll("name");
        if (!names.length)
          return sendJson(res, 400, { error: "name is required" });
        const entries: ZipEntry[] = [];
        const budget = { left: EXPORT_LIMIT };
        for (const name of names) {
          const skill = findSkill(vaultDir, name);
          if (!skill)
            return sendJson(res, 404, { error: `skill not found: ${name}` });
          // The folder name leads every path, so a multi-skill archive opens
          // as one folder per skill instead of a pile of loose SKILL.md files.
          collectFiles(skill.dir, skill.name, entries, budget);
        }
        const body = zip(entries);
        // One skill keeps its own name; several become a dated bundle, since
        // no single name is honest about what is inside.
        const file =
          names.length === 1
            ? `${names[0]}.zip`
            : `skills-${new Date().toISOString().slice(0, 10)}.zip`;
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": body.length,
          "content-disposition": `attachment; filename="${file}"`,
          "cache-control": "no-store",
        });
        return res.end(body);
      }
      if (route === "GET /api/skill") {
        const skill = findSkill(vaultDir, url.searchParams.get("name"));
        if (!skill) return sendJson(res, 404, { error: "skill not found" });
        const cfg = loadConfig(vaultDir);
        const md = path.join(skill.dir, "SKILL.md");
        const archived = isArchivedSkill(vaultDir, skill);
        return sendJson(res, 200, {
          name: skill.name,
          dir: skill.dir,
          category: path.relative(vaultDir, path.dirname(skill.dir)) || ".",
          description: parseFrontmatterField(md, "description") ?? "",
          archived,
          // Archiving no longer records a reason (folder-based archive).
          reason: "",
          // Raw SKILL.md frontmatter block, so the detail can render taxonomy
          // chips in the header and the metadata object in the rail.
          frontmatter: (() => {
            try {
              // Normalize CRLF: the frontmatter regex needs LF delimiters, and
              // archived skills (browsable here) may carry CRLF endings.
              const src = readFileSync(md, "utf8").replace(/\r\n/g, "\n");
              const fmM = /^---\n([\s\S]*?)\n---/.exec(src);
              return fmM ? fmM[1] : "";
            } catch {
              return "";
            }
          })(),
          files: listSkillFiles(skill.dir),
          // Archived skills carry no live runtime links.
          states: archived
            ? []
            : statusMatrix([skill], cfg, vaultDir).map((m) => ({
                consumer: m.consumer,
                state: m.state,
              })),
        });
      }
      if (route === "GET /api/file") {
        const f = resolveVaultFile(vaultDir, url);
        if (!f.ok) return sendJson(res, f.code, { error: f.error });
        const st = statSync(f.real);
        const kind = fileKind(f.real);
        // The image check comes first: the size cap protects the JSON payload,
        // and an image no longer travels in it — a photo in a skill's assets/
        // is routinely megabytes and would otherwise read as a binary blob.
        if (kind === "image")
          return sendJson(res, 200, {
            kind,
            size: st.size,
            src: `/api/file-raw?name=${encodeURIComponent(f.name)}&path=${encodeURIComponent(f.rel)}`,
          });
        if (st.size > 1024 * 1024 || kind === "binary")
          return sendJson(res, 200, { kind: "binary", size: st.size });
        return sendJson(res, 200, {
          kind,
          size: st.size,
          content: readFileSync(f.real, "utf8"),
        });
      }
      if (route === "GET /api/file-raw") {
        const f = resolveVaultFile(vaultDir, url);
        if (!f.ok) return sendJson(res, f.code, { error: f.error });
        return sendImage(res, f.real);
      }
      if (route === "GET /api/file-download") {
        const f = resolveVaultFile(vaultDir, url);
        if (!f.ok) return sendJson(res, f.code, { error: f.error });
        return sendDownload(res, f.real, f.rel);
      }
      if (route === "GET /api/history") {
        const skill = findSkill(vaultDir, url.searchParams.get("name"));
        if (!skill) return sendJson(res, 404, { error: "skill not found" });
        // Optional ?path scopes the log to one file in the skill, so the rail
        // tracks the file the viewer shows, not always SKILL.md. --follow keeps
        // the history across renames; it needs a single file pathspec, so it is
        // only added when a path is given.
        const rel = url.searchParams.get("path");
        const scoped = scopedTarget(skill.dir, rel);
        if (scoped === null)
          return sendJson(res, 400, { error: "path escapes skill directory" });
        const out = spawnSync(
          "git",
          [
            "-C",
            vaultDir,
            "log",
            "--format=%h%x09%ad%x09%s",
            "--date=format:%Y-%m-%dT%H:%M",
            ...(rel ? ["--follow"] : []),
            "--",
            scoped,
          ],
          { encoding: "utf8" },
        );
        if (out.error || out.status !== 0)
          return sendJson(res, 200, { versioned: false });
        const commits = out.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash = "", date = "", ...rest] = l.split("\t");
            return { hash, date, subject: rest.join("\t") };
          });
        return sendJson(res, 200, { versioned: true, commits });
      }
      if (route === "GET /api/doc-history") {
        // git history of a config doc (a vault-root governance file or loom.json),
        // so the Config reference panes can show the same history as skills do.
        const name = url.searchParams.get("name") ?? "";
        if (![...GOVERNANCE_DOCS, CONFIG_NAME].includes(name))
          return sendJson(res, 400, { error: "not a config doc" });
        const file = path.join(vaultDir, name);
        if (!existsSync(file)) return sendJson(res, 200, { versioned: false });
        const out = spawnSync(
          "git",
          [
            "-C",
            vaultDir,
            "log",
            "--format=%h%x09%ad%x09%s",
            "--date=format:%Y-%m-%dT%H:%M",
            "--",
            file,
          ],
          { encoding: "utf8" },
        );
        if (out.error || out.status !== 0)
          return sendJson(res, 200, { versioned: false });
        const commits = out.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const [hash = "", date = "", ...rest] = l.split("\t");
            return { hash, date, subject: rest.join("\t") };
          });
        return sendJson(res, 200, { versioned: true, commits });
      }
      if (route === "GET /api/doc-commit") {
        const name = url.searchParams.get("name") ?? "";
        if (![...GOVERNANCE_DOCS, CONFIG_NAME].includes(name))
          return sendJson(res, 400, { error: "not a config doc" });
        const hash = url.searchParams.get("hash") ?? "";
        if (!/^[0-9a-f]{7,40}$/.test(hash))
          return sendJson(res, 400, { error: "invalid hash" });
        const out = spawnSync(
          "git",
          ["-C", vaultDir, "show", hash, "--", path.join(vaultDir, name)],
          { encoding: "utf8" },
        );
        if (out.error || out.status !== 0)
          return sendJson(res, 400, { error: "unknown commit" });
        return sendJson(res, 200, { diff: out.stdout });
      }
      if (route === "GET /api/commit") {
        const skill = findSkill(vaultDir, url.searchParams.get("name"));
        if (!skill) return sendJson(res, 404, { error: "skill not found" });
        const hash = url.searchParams.get("hash") ?? "";
        if (!/^[0-9a-f]{7,40}$/.test(hash))
          return sendJson(res, 400, { error: "invalid hash" });
        // ?path narrows the diff to the file the viewer is showing, so opening a
        // commit from a file's history shows that file's change, not the whole skill.
        const scoped = scopedTarget(skill.dir, url.searchParams.get("path"));
        if (scoped === null)
          return sendJson(res, 400, { error: "path escapes skill directory" });
        const out = spawnSync(
          "git",
          ["-C", vaultDir, "show", hash, "--", scoped],
          { encoding: "utf8" },
        );
        if (out.error || out.status !== 0)
          return sendJson(res, 400, { error: "unknown commit" });
        return sendJson(res, 200, { diff: out.stdout });
      }
      if (route === "GET /api/sync")
        // ?fetch=1 refreshes origin first, so "behind" reflects the live
        // remote (used by the on-open check), not the last fetch.
        return sendJson(
          res,
          200,
          syncStatus(vaultDir, url.searchParams.get("fetch") === "1"),
        );
      if (route === "POST /api/sync") {
        const body = await readBody(req);
        const apply = body.apply === true;
        // `force` is the escape hatch that skips the doctor gate before
        // committing — reasonable for the operator sitting at the machine,
        // not for an unauthenticated caller over the network. --allow-remote-
        // writes opens every write endpoint at once; this one commits the whole
        // working tree and pushes it, so the bypass stays local-only.
        const force = body.force === true;
        if (force && !forceSyncAllowed(req.socket.remoteAddress ?? ""))
          return sendJson(res, 403, {
            error:
              "force sync is local-only: it skips the doctor gate, commits the whole tree and pushes. Run it from the machine hosting the vault.",
          });
        return sendOp(res, syncOp(vaultDir, apply, force), apply);
      }
      if (route === "POST /api/link-toggle") {
        const body = await readBody(req);
        const consumer = str(body.consumer);
        const on = body.on === true;
        const apply = body.apply === true;
        if (!consumer)
          return sendJson(res, 400, { error: "consumer required" });
        const cfg = loadConfig(vaultDir);
        if (!(consumer in cfg.consumers))
          return sendJson(res, 400, {
            error: `unknown consumer "${consumer}"`,
          });
        const skills = scanVault(vaultDir, cfg);
        const name = str(body.name) ?? null;
        const { actions, skipped } = setSkillLinks(
          skills,
          cfg,
          consumer,
          name,
          on,
          apply,
        );
        return sendJson(res, 200, { applied: apply, actions, skipped });
      }
      if (route === "POST /api/link-skill-everywhere") {
        // "Link everywhere": link one skill into every symlink consumer at once.
        // In-place consumers are vault-level (not per-skill) and stay untouched.
        const body = await readBody(req);
        const name = str(body.name);
        const apply = body.apply === true;
        if (!name) return sendJson(res, 400, { error: "name required" });
        const cfg = loadConfig(vaultDir);
        const skills = scanVault(vaultDir, cfg);
        const skill = skills.find((s) => s.name === name);
        if (!skill)
          return sendJson(res, 400, { error: `unknown skill "${name}"` });
        if (!isLinked(skill))
          return sendJson(res, 400, {
            error: `"${name}" is ${skill.status ?? "unset"}; only active or draft skills project to runtimes`,
          });
        const { actions, skipped } = setSkillEverywhere(
          skills,
          cfg,
          name,
          apply,
        );
        return sendJson(res, 200, { applied: apply, actions, skipped });
      }
      if (route === "POST /api/inplace-toggle") {
        // Activate/deactivate an in-place consumer by editing the array it is
        // served through (e.g. OpenClaw's extraDirs). Never restarts anything —
        // the caller is told to reload the runtime.
        const body = await readBody(req);
        const consumer = str(body.consumer);
        const on = body.on === true;
        const apply = body.apply === true;
        if (!consumer)
          return sendJson(res, 400, { error: "consumer required" });
        const c = resolveConsumers(loadConfig(vaultDir)).find(
          (x) => x.name === consumer,
        );
        if (!c || c.mode !== "in-place" || !c.servedVia)
          return sendJson(res, 400, {
            error: `"${consumer}" is not an in-place consumer with a servedVia config`,
          });
        const action = `${on ? "add" : "remove"} the vault in ${c.servedVia.file} → ${c.servedVia.jsonPath}`;
        if (!apply)
          return sendJson(res, 200, { applied: false, actions: [action] });
        const { changed } = setServed(vaultDir, c.servedVia, on);
        return sendJson(res, 200, {
          applied: true,
          changed,
          message: changed
            ? `${on ? "Activated" : "Deactivated"} — restart the runtime to apply.`
            : "Already in that state.",
        });
      }
      if (route === "POST /api/restore") {
        const body = await readBody(req);
        const apply = body.apply === true;
        return sendOp(res, restoreOp(vaultDir, str(body.name), apply), apply);
      }
      if (route === "POST /api/remote") {
        const body = await readBody(req);
        const apply = body.apply === true;
        return sendOp(res, setRemote(vaultDir, str(body.url), apply), apply);
      }
      if (route === "POST /api/consumers") {
        // Add a runtime: name -> skills dir, written to loom.json. Linking
        // into it stays a separate, dry-run-gated step (link --apply / UI).
        const body = await readBody(req);
        const name = str(body.name)?.toLowerCase().trim();
        const target = str(body.path)?.trim();
        if (!name || !/^[a-z0-9][a-z0-9-]{0,32}$/.test(name))
          return sendJson(res, 400, {
            error: "name must be a short lowercase-kebab identifier",
          });
        if (!target) return sendJson(res, 400, { error: "path is required" });
        const cfg = loadConfig(vaultDir);
        if (cfg.consumers[name])
          return sendJson(res, 400, {
            error: `runtime "${name}" already exists`,
          });
        cfg.consumers[name] = target;
        saveConfig(vaultDir, cfg);
        return sendJson(res, 200, { ok: true, consumers: cfg.consumers });
      }
      if (route === "POST /api/names") {
        // Edit the vault's custom word-casing map (loom.json `names`).
        // { word, cased } adds/updates; { word, remove: true } deletes.
        const body = await readBody(req);
        const word = str(body.word)?.toLowerCase().trim();
        if (!word || /\s|-/.test(word))
          return sendJson(res, 400, {
            error: "word must be a single kebab segment (no spaces or dashes)",
          });
        const cfg = loadConfig(vaultDir);
        if (body.remove === true) {
          delete cfg.names[word];
        } else {
          const cased = str(body.cased)?.trim();
          if (!cased) return sendJson(res, 400, { error: "cased is required" });
          cfg.names[word] = cased;
        }
        saveConfig(vaultDir, cfg);
        return sendJson(res, 200, { ok: true, names: cfg.names });
      }
      if (route === "POST /api/rules") {
        // Editing the rules re-arms the gate that blocks skill saves, so this is the
        // one config write that goes through a dry-run: apply:false returns the
        // impact on today's skills; apply:true writes the lint block.
        const body = await readBody(req);
        const cfg = loadConfig(vaultDir);
        const err = validateLint(body.lint, resolveAxes(cfg));
        if (err) return sendJson(res, 400, { error: err });
        const lint = body.lint as LintConfig;
        if (body.apply === true) {
          // Merge, don't replace: the dashboard's Rules pane only knows a
          // fixed 9-field subset of LintConfig (see normalizedLint in
          // src/ui.js) and always posts exactly that shape. A wholesale
          // `cfg.lint = lint` would silently drop any lint key the
          // dashboard doesn't render yet (e.g. structuredDocs,
          // absolutePathIgnoreFiles) on every save, whatever field the
          // user actually meant to edit. Merging keeps those fields intact
          // while still letting the posted object overwrite every field it
          // does know — the dashboard always sends all 9 known fields
          // (cleared ones as null/[]/false, never omitted), so there is no
          // "omit to delete" convention this merge could break.
          cfg.lint = { ...cfg.lint, ...lint };
          saveConfig(vaultDir, cfg);
          return sendJson(res, 200, { ok: true, lint: cfg.lint });
        }
        return sendJson(res, 200, {
          ok: true,
          impact: rulesImpact(vaultDir, lint),
        });
      }
      if (route === "GET /api/loom-json") {
        const file = path.join(vaultDir, CONFIG_NAME);
        if (!existsSync(file))
          return sendJson(res, 404, { error: "no loom.json" });
        return sendJson(res, 200, { content: readFileSync(file, "utf8") });
      }
      if (route === "POST /api/bulk/status") {
        const body = await readBody(req);
        const names = strArr(body.names);
        if (!names)
          return sendJson(res, 400, {
            error: "names must be a non-empty string array",
          });
        const apply = body.apply === true;
        return sendOp(
          res,
          bulkStatusOp(vaultDir, names, str(body.status) ?? "", apply),
          apply,
        );
      }
      if (route === "POST /api/bulk/taxonomy") {
        const body = await readBody(req);
        const names = strArr(body.names);
        if (!names)
          return sendJson(res, 400, {
            error: "names must be a non-empty string array",
          });
        const field = str(body.field);
        if (!field) return sendJson(res, 400, { error: "field is required" });
        const ids = resolveAxes(loadConfig(vaultDir)).map((a) => a.id);
        if (!ids.includes(field))
          return sendJson(res, 400, {
            error: `field must be one of: ${ids.join(", ")}`,
          });
        const apply = body.apply === true;
        return sendOp(
          res,
          bulkTaxonomyOp(vaultDir, names, field, str(body.value) ?? "", apply),
          apply,
        );
      }
      if (route === "POST /api/bulk/archive") {
        const body = await readBody(req);
        const names = strArr(body.names);
        if (!names)
          return sendJson(res, 400, {
            error: "names must be a non-empty string array",
          });
        const apply = body.apply === true;
        return sendOp(res, bulkArchiveOp(vaultDir, names, apply), apply);
      }
      if (route === "POST /api/bulk/restore") {
        const body = await readBody(req);
        const names = strArr(body.names);
        if (!names)
          return sendJson(res, 400, {
            error: "names must be a non-empty string array",
          });
        const apply = body.apply === true;
        return sendOp(res, bulkRestoreOp(vaultDir, names, apply), apply);
      }
      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof UsageError)
        return sendJson(res, 400, { error: err.message });
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
