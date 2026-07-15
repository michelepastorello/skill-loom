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
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  saveConfig,
  expandTilde,
  resolveConsumers,
  validateLint,
  CONFIG_NAME,
  type LoomConfig,
  type LintConfig,
} from "./config.js";
import { rulesImpact } from "./gate.js";
import { setServed } from "./inplace.js";
import {
  scanVault,
  validateVault,
  skillWarnings,
  parseFrontmatterField,
  parseFrontmatterName,
  parseFirstH1,
  ARCHIVE_DIR,
  type Skill,
} from "./vault.js";
import {
  orphanLinks,
  planLinks,
  applyPlan,
  statusMatrix,
  setSkillLinks,
  type LinkState,
} from "./linker.js";
import {
  addOp,
  archiveOp,
  bulkArchiveOp,
  bulkRenameOp,
  bulkRestoreOp,
  bulkStatusOp,
  bulkTaxonomyOp,
  migrateOp,
  restoreOp,
  type OpOutcome,
  type RenameTransform,
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
  "gpt", "tts", "crm", "ynab", "nas", "pptx", "en", "it", "pmf",
]);
const PROPER: Record<string, string> = {
  agents: "AGENTS",
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
  states: LinkState[],
): "active" | "attention" | "inactive" {
  // "served" (in-place, read straight from the vault) is as healthy as "linked".
  const healthy = (s: LinkState) => s === "linked" || s === "served";
  if (states.some((s) => s === "broken" || s === "foreign")) return "attention";
  if (states.length > 0 && states.every(healthy)) return "active";
  if (states.some(healthy)) return "attention";
  return "inactive";
}

// Vault-root governance docs surfaced (read-only) in the dashboard's Rules
// view. A fixed whitelist doubles as the path guard for GET /api/doc.
const GOVERNANCE_DOCS = ["CONVENTIONS.md", "README.md", "source-registry.yaml"];

// Archived skills come from the real archive/ folder (the source of truth) —
// loom.json's `archived` list only adds date/reason metadata when present, so
// a skill moved into archive/ by hand still shows up.
function scanArchived(vaultDir: string, cfg: LoomConfig) {
  const dir = path.join(vaultDir, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
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
        domain: parseFrontmatterField(md, "domain"),
        layer: parseFrontmatterField(md, "layer"),
        status: parseFrontmatterField(md, "status") ?? "active",
        date: st ? st.mtime.toISOString().slice(0, 10) : "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildState(vaultDir: string): object {
  const cfg = loadConfig(vaultDir);
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
        domain: parseFrontmatterField(md, "domain"),
        layer: parseFrontmatterField(md, "layer"),
        status: parseFrontmatterField(md, "status") ?? "active",
        sync: syncOf(path.relative(vaultDir, s.dir)),
        description: parseFrontmatterField(md, "description") ?? "",
        modified: st ? st.mtime.toISOString().slice(0, 10) : "",
      };
    }),
    problems: validateVault(skills),
    warnings: skillWarnings(skills, cfg),
    matrix,
    orphans: orphanLinks(vaultDir, cfg, skills),
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
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new UsageError("invalid JSON body");
  }
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

function serveHtml(res: ServerResponse): void {
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "ui.html",
  );
  const html = readFileSync(htmlPath, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
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

function listSkillFiles(
  skillDir: string,
): { path: string; size: number; kind: "text" | "image" | "binary" }[] {
  const out: {
    path: string;
    size: number;
    kind: "text" | "image" | "binary";
  }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        out.push({
          path: path.relative(skillDir, full),
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

function findSkill(vaultDir: string, name: string | null): Skill | undefined {
  if (!name) return undefined;
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

export function createUiServer(vaultDir: string): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /") return serveHtml(res);
      if (route === "GET /api/state")
        return sendJson(res, 200, buildState(vaultDir));
      if (route === "GET /api/diff")
        return sendJson(res, 200, gitDiff(vaultDir));
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
        const items = planLinks(skills, cfg);
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
        return sendOp(
          res,
          addOp(
            vaultDir,
            str(body.name),
            {
              description: str(body.description),
              domain: str(body.domain),
              layer: str(body.layer),
              status: str(body.status),
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
          archiveOp(
            vaultDir,
            str(body.name),
            str(body.reason),
            body.apply === true,
          ),
          body.apply === true,
        );
      }
      if (route === "POST /api/migrate") {
        const body = await readBody(req);
        return sendOp(
          res,
          migrateOp(
            vaultDir,
            str(body.old),
            str(body.new),
            body.apply === true,
          ),
          body.apply === true,
        );
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
              const src = readFileSync(md, "utf8");
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
            : statusMatrix([skill], cfg).map((m) => ({
                consumer: m.consumer,
                state: m.state,
              })),
        });
      }
      if (route === "GET /api/file") {
        const skill = findSkill(vaultDir, url.searchParams.get("name"));
        if (!skill) return sendJson(res, 404, { error: "skill not found" });
        const target = path.join(skill.dir, url.searchParams.get("path") ?? "");
        let real: string;
        try {
          real = realpathSync(target);
        } catch {
          return sendJson(res, 404, { error: "file not found" });
        }
        const skillReal = realpathSync(skill.dir);
        if (real !== skillReal && !real.startsWith(skillReal + path.sep)) {
          return sendJson(res, 400, { error: "path escapes skill directory" });
        }
        const st = statSync(real);
        if (!st.isFile()) return sendJson(res, 400, { error: "not a file" });
        const kind = fileKind(real);
        if (st.size > 1024 * 1024 || kind === "binary")
          return sendJson(res, 200, { kind: "binary", size: st.size });
        if (kind === "image") {
          const mime =
            IMAGE_MIME[path.extname(real).toLowerCase()] ??
            "application/octet-stream";
          return sendJson(res, 200, {
            kind,
            size: st.size,
            content: `data:${mime};base64,${readFileSync(real).toString("base64")}`,
          });
        }
        return sendJson(res, 200, {
          kind,
          size: st.size,
          content: readFileSync(real, "utf8"),
        });
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
            "--date=short",
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
            "--date=short",
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
        return sendOp(res, syncOp(vaultDir, apply, body.force === true), apply);
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
        const err = validateLint(body.lint);
        if (err) return sendJson(res, 400, { error: err });
        const lint = body.lint as LintConfig;
        if (body.apply === true) {
          const cfg = loadConfig(vaultDir);
          cfg.lint = lint;
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
        if (field !== "domain" && field !== "layer")
          return sendJson(res, 400, { error: "field must be domain or layer" });
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
      if (route === "POST /api/bulk/rename") {
        const body = await readBody(req);
        const names = strArr(body.names);
        if (!names)
          return sendJson(res, 400, {
            error: "names must be a non-empty string array",
          });
        const t = body.transform as RenameTransform | undefined;
        const ops = ["add-prefix", "strip-prefix", "replace"];
        if (!t || typeof t !== "object" || !ops.includes(t.op))
          return sendJson(res, 400, {
            error: "transform.op must be add-prefix, strip-prefix or replace",
          });
        const apply = body.apply === true;
        return sendOp(res, bulkRenameOp(vaultDir, names, t, apply), apply);
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
