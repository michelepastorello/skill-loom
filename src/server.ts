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
import { loadConfig, saveConfig, expandTilde } from "./config.js";
import {
  scanVault,
  validateVault,
  parseFrontmatterField,
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
  migrateOp,
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
  "gpt", "tts", "crm", "ynab", "nas", "pptx", "en", "it",
]);
const PROPER: Record<string, string> = {
  linkedin: "LinkedIn",
  openai: "OpenAI",
  openclaw: "OpenClaw",
  github: "GitHub",
  posthog: "PostHog",
  heygen: "HeyGen",
  npm: "npm",
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
  if (states.some((s) => s === "broken" || s === "foreign")) return "attention";
  if (states.length > 0 && states.every((s) => s === "linked")) return "active";
  if (states.some((s) => s === "linked")) return "attention";
  return "inactive";
}

export function buildState(vaultDir: string): object {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const matrix = statusMatrix(skills, cfg);
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
    archived: cfg.archived,
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
    matrix,
    orphans: orphanLinks(vaultDir, cfg, skills),
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
  ".txt",
  ".py",
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
  return scanVault(vaultDir, loadConfig(vaultDir)).find((s) => s.name === name);
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
            str(body.category),
            str(body.description),
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
        return sendJson(res, 200, {
          name: skill.name,
          dir: skill.dir,
          category: path.relative(vaultDir, path.dirname(skill.dir)) || ".",
          description: parseFrontmatterField(md, "description") ?? "",
          files: listSkillFiles(skill.dir),
          states: statusMatrix([skill], cfg).map((m) => ({
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
        const out = spawnSync(
          "git",
          [
            "-C",
            vaultDir,
            "log",
            "--format=%h%x09%ad%x09%s",
            "--date=short",
            "--",
            skill.dir,
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
      if (route === "GET /api/commit") {
        const skill = findSkill(vaultDir, url.searchParams.get("name"));
        if (!skill) return sendJson(res, 404, { error: "skill not found" });
        const hash = url.searchParams.get("hash") ?? "";
        if (!/^[0-9a-f]{7,40}$/.test(hash))
          return sendJson(res, 400, { error: "invalid hash" });
        const out = spawnSync(
          "git",
          ["-C", vaultDir, "show", hash, "--", skill.dir],
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
        return sendOp(res, syncOp(vaultDir, apply), apply);
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
