import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { vaultRepo } from "./sync.js";

/** A non-fresh graph family, as the UI reads it. `command` is the ready-to-run
 *  retrigger string (contract-verbatim `graphify-refresh.py <family>`). */
export interface FamilyStatus {
  family: string;
  state: "pending" | "stuck";
  fails: number;
  reason: string;
  lastAttempt: string | null;
  command: string;
}
/** One family inside a run. `total`/`completed` only ever said how many were
 *  through, never which: two families done and one failed reads the same as one
 *  of each until every family carries its own state. Written by the refresh
 *  pipeline under `run.family_state`; absent on older status files, in which
 *  case the UI falls back to the counter. */
export interface RunFamily {
  family: string;
  state: "queued" | "running" | "applying" | "done" | "failed";
  skills: number;
  seconds: number | null;
  /** When the family started extracting. `seconds` only exists once it is
   *  through, so a running family needs this to show elapsed time. */
  startedAt: string | null;
  provider: string | null;
  reason: string;
}

export interface GraphRunStatus {
  state: "extracting" | "applying" | "idle";
  total: number;
  completed: number;
  workers: number;
  families: string[];
  familyState: RunFamily[];
  lastCompleted: string | null;
  lastProvider: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The cross-linking pass after extraction. On a full-vault run it outlives
   *  the extraction itself (one confirmation per touched skill), and without it
   *  the panel showed every family done while the run kept going with no
   *  visible reason. `current` is a list: the pass runs several skills at once,
   *  so a single name would hide the rest. Absent on status files from older
   *  pipelines; a string there is the serial pipeline's one live skill. */
  cross: { done: number; total: number; current: string[] } | null;
}

/** A family whose skills moved in git after the graph was built. Derived from
 *  the vault repo, not from the pipeline: a family is stale the moment its
 *  markdown changes, hours before any refresh run declares it pending. */
/** Epoch seconds at which a refresh already scheduled will start. The hook
 *  waits out a quiet window so a burst of commits pays one run; without
 *  surfacing it, that wait is indistinguishable from a refresh that never
 *  fires, which is exactly how it reads to whoever just hit save. */
export interface StaleFamily {
  family: string;
  skills: string[];
  commits: number;
  command: string;
}

/** Freshness of the vault's knowledge graph. `hasGraph:false` means no graph is
 *  built (no badge). Otherwise `pending` empty === fully fresh; `commitsBehind`
 *  is how far HEAD has moved past the graph, or null when it can't be told. */
export type GraphFreshness =
  | { hasGraph: false }
  | {
      hasGraph: true;
      freshThroughCommit: string | null;
      updatedAt: string | null;
      commitsBehind: number | null;
      pending: FamilyStatus[];
      run: GraphRunStatus | null;
      stale: StaleFamily[];
      /** Epoch seconds when the armed refresh starts, or null when none is
       *  waiting. Stale markers (older than the longest sane window) are
       *  ignored rather than shown as a refresh that is late. */
      armedAt: number | null;
    };

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// The status file is written by an external script, so trust nothing: any
// malformed entry is dropped rather than surfaced as a real family.
function parsePending(raw: unknown): FamilyStatus[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: FamilyStatus[] = [];
  for (const [family, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const state =
      e.state === "stuck" ? "stuck" : e.state === "pending" ? "pending" : null;
    if (!state) continue;
    out.push({
      family,
      state,
      fails:
        typeof e.fails === "number" && Number.isFinite(e.fails) ? e.fails : 0,
      reason: typeof e.reason === "string" ? e.reason : "",
      lastAttempt: typeof e.last_attempt === "string" ? e.last_attempt : null,
      command: `graphify-refresh.py ${family}`,
    });
  }
  // Stuck first (actionable), then alphabetical for a stable order.
  return out.sort((a, b) =>
    a.state === b.state
      ? a.family.localeCompare(b.family)
      : a.state === "stuck"
        ? -1
        : 1,
  );
}

// Written by an external pipeline, so every entry is validated and a malformed
// one is dropped rather than surfaced as a family in an invented state.
function parseFamilyState(raw: unknown): RunFamily[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  // Pipeline order, not lifecycle order: what needs a decision, then what is
  // happening, then what is about to happen, then what is settled. A family
  // that finished extraction ("applying") is work already banked — reading it
  // above the queue put the finished half of a 47-family run between the user
  // and the part of it still moving.
  const order = {
    failed: 0,
    running: 1,
    queued: 2,
    applying: 3,
    done: 4,
  } as const;
  const out: RunFamily[] = [];
  for (const [family, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const state =
      entry.state === "queued" ||
      entry.state === "running" ||
      entry.state === "applying" ||
      entry.state === "done" ||
      entry.state === "failed"
        ? entry.state
        : null;
    if (!state) continue;
    out.push({
      family,
      state,
      skills:
        typeof entry.skills === "number" && Number.isFinite(entry.skills)
          ? Math.max(0, Math.floor(entry.skills))
          : 0,
      seconds:
        typeof entry.seconds === "number" && Number.isFinite(entry.seconds)
          ? entry.seconds
          : null,
      startedAt: typeof entry.started_at === "string" ? entry.started_at : null,
      provider: typeof entry.provider === "string" ? entry.provider : null,
      reason: typeof entry.reason === "string" ? entry.reason : "",
    });
  }
  // Running first, then what needs a decision, then what is settled.
  return out.sort(
    (a, b) =>
      order[a.state] - order[b.state] || a.family.localeCompare(b.family),
  );
}

function parseRun(raw: unknown): GraphRunStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const state =
    value.state === "extracting" ||
    value.state === "applying" ||
    value.state === "idle"
      ? value.state
      : null;
  if (!state) return null;
  const number = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.max(0, Math.floor(candidate))
      : 0;
  return {
    state,
    total: number(value.total),
    completed: number(value.completed),
    workers: number(value.workers),
    families: Array.isArray(value.families)
      ? value.families.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    familyState: parseFamilyState(value.family_state),
    lastCompleted:
      typeof value.last_completed === "string" ? value.last_completed : null,
    lastProvider:
      typeof value.last_provider === "string" ? value.last_provider : null,
    startedAt: typeof value.started_at === "string" ? value.started_at : null,
    finishedAt:
      typeof value.finished_at === "string" ? value.finished_at : null,
    cross: parseCross(value.cross),
  };
}

// External writer, trust nothing: a malformed cross block renders as absent,
// never as NaN progress.
function parseCross(
  raw: unknown,
): { done: number; total: number; current: string[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const count = (candidate: unknown): number | null =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
      ? Math.floor(candidate)
      : null;
  const done = count(value.done);
  const total = count(value.total);
  if (done === null || total === null) return null;
  // A string is the serial pipeline's single live skill; anything else that
  // isn't a list of names is simply nothing in flight.
  const current = Array.isArray(value.current)
    ? value.current.filter((name): name is string => typeof name === "string")
    : typeof value.current === "string"
      ? [value.current]
      : [];
  return { done, total, current };
}

function git(vaultDir: string, ...args: string[]) {
  return spawnSync("git", ["-C", vaultDir, ...args], { encoding: "utf8" });
}

// K = commits reachable from HEAD but not from the fresh sha. null when it can't
// be computed honestly: not a repo root, no fresh sha, sha not an ancestor of
// HEAD (rewritten/foreign), or any git error.
function computeCommitsBehind(
  vaultDir: string,
  fresh: string | null,
): number | null {
  if (!fresh) return null;
  if (!vaultRepo(vaultDir).isRoot) return null;
  const anc = git(vaultDir, "merge-base", "--is-ancestor", fresh, "HEAD");
  if (anc.status !== 0) return null;
  const rl = git(vaultDir, "rev-list", "--count", `${fresh}..HEAD`);
  if (rl.status !== 0) return null;
  const n = parseInt(rl.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Commits between `fresh` and HEAD that actually touched something the vault
 *  graph is built from. A commit that only changes scripts, docs or a
 *  live-state file cannot make the graph stale, and counting it lights the badge
 *  for work no refresh would ever do: the number stops meaning anything and the
 *  reader learns to ignore it. Same predicate the stale-family list uses. */
function semanticCommitsBehind(
  vaultDir: string,
  fresh: string | null,
): number | null {
  if (!fresh) return null;
  if (!vaultRepo(vaultDir).isRoot) return null;
  if (git(vaultDir, "merge-base", "--is-ancestor", fresh, "HEAD").status !== 0)
    return null;
  const log = git(
    vaultDir,
    "log",
    "--format=%x00%H",
    "--name-only",
    `${fresh}..HEAD`,
  );
  if (log.status !== 0) return null;
  let count = 0;
  for (const commit of log.stdout.split("\u0000")) {
    const [, ...files] = commit.split("\n");
    if (files.some((file) => isSemanticMarkdown(file.trim()))) count += 1;
  }
  return count;
}

/** Commits between an arbitrary build commit and HEAD, whatever they touched.
 *  Exported for the code graph, which is built from the code and therefore has
 *  no reason to share the markdown predicate. */
export function commitsBehindHead(
  vaultDir: string,
  commit: string | null,
): number | null {
  return computeCommitsBehind(vaultDir, commit);
}

// graphify-refresh.py: markdown only, never live-state.md, never under one of
// these directories. Keep the two in step or the dashboard invents work.
const NON_SEMANTIC_DIRS = new Set([
  ".archive",
  "graphify-out",
  "graphify-code",
  "docs",
  "scripts",
  "assets",
]);

function isSemanticMarkdown(rel: string): boolean {
  if (!rel.endsWith(".md")) return false;
  const parts = rel.split("/");
  if (parts[parts.length - 1] === "live-state.md") return false;
  return !parts.some((part) => NON_SEMANTIC_DIRS.has(part));
}

// graphify-refresh.py: COSMETIC_FRONTMATTER_KEYS. Un'icona, un colore o una
// casella di tassonomia non cambiano quello che il grafo estrae, quindi la
// pipeline scarta il file ("solo frontmatter cosmetico — skip"). Senza lo
// stesso taglio qui, il pannello elenca famiglie che nessun refresh toccherà.
const COSMETIC_FRONTMATTER_KEYS = [
  "icon:",
  "icon-color:",
  "status:",
  "domain:",
  "area:",
  "kind:",
];

/** Il testo senza le righe cosmetiche del frontmatter e senza differenze di
 *  spaziatura, per confronto — gemello di `strip_cosmetic_frontmatter`. */
function semanticText(text: string): string {
  const lines = text.split("\n");
  let end = -1;
  // Stessa asimmetria del gemello Python (`lines[0].strip()`, poi
  // `lines.index("---", 1)` esatto): allargarla qui scarterebbe come cosmetico
  // un file che la pipeline invece estrae.
  if (lines[0]?.trim() === "---")
    for (let i = 1; i < lines.length; i++)
      if (lines[i] === "---") {
        end = i;
        break;
      }
  const kept = lines.filter((line, i) => {
    if (end === -1 || i === 0 || i > end) return true;
    const trimmed = line.trimStart();
    return !COSMETIC_FRONTMATTER_KEYS.some((key) => trimmed.startsWith(key));
  });
  return kept.join("\n").split(/\s+/).join(" ").trim();
}

// Un `git show` per file cambiato, su un percorso che la dashboard ripercorre
// ogni 5 secondi: misurato, un diff da 104 file costava 993ms a giro. La chiave
// porta mtime e size perché il confronto è contro il file SUL DISCO, non contro
// HEAD: un salvataggio senza commit deve poter cambiare la risposta.
const cosmeticCache = new Map<string, boolean>();
const COSMETIC_CACHE_MAX = 2000;

/** True quando fra `base` e HEAD questo file cambia SOLO per chiavi cosmetiche.
 *  Un file nuovo non ha versione precedente: non è un cambio cosmetico, è tutto
 *  da estrarre. Un `git show` che fallisce per altri motivi porta allo stesso
 *  esito prudente — meglio una riga di troppo che una skill mai rinfrescata. */
function cosmeticOnlyChange(
  vaultDir: string,
  rel: string,
  base: string,
): boolean {
  const full = path.join(vaultDir, rel);
  let key = "";
  try {
    const st = statSync(full);
    key = `${vaultDir}\0${base}\0${rel}\0${st.mtimeMs}\0${st.size}`;
    const hit = cosmeticCache.get(key);
    if (hit !== undefined) return hit;
  } catch {
    return false; // sparito dal disco: non è un ritocco all'icona
  }
  const answer = computeCosmeticOnly(vaultDir, rel, base, full);
  if (cosmeticCache.size >= COSMETIC_CACHE_MAX) cosmeticCache.clear();
  cosmeticCache.set(key, answer);
  return answer;
}

function computeCosmeticOnly(
  vaultDir: string,
  rel: string,
  base: string,
  full: string,
): boolean {
  const before = git(vaultDir, "show", `${base}:${rel}`);
  if (before.status !== 0) return false;
  let after: string;
  try {
    after = readFileSync(full, "utf8");
  } catch {
    return false;
  }
  return semanticText(before.stdout) === semanticText(after);
}

/** Families whose skills changed after the graph's build commit. This is what
 *  "3 families to refresh" means: it comes from the vault repo, so it is known
 *  before any run starts, and it excludes families already in flight. */
export function staleFamilies(
  vaultDir: string,
  fresh: string | null,
  inFlight: string[] = [],
): StaleFamily[] {
  if (!fresh) return [];
  if (!vaultRepo(vaultDir).isRoot) return [];
  if (git(vaultDir, "merge-base", "--is-ancestor", fresh, "HEAD").status !== 0)
    return [];
  const diff = git(vaultDir, "diff", "--name-only", `${fresh}..HEAD`);
  if (diff.status !== 0) return [];
  const busy = new Set(inFlight);
  const bySkill = new Map<string, Set<string>>();
  for (const line of diff.stdout.split("\n")) {
    const rel = line.trim();
    if (!rel || rel.startsWith(".") || !rel.includes("/")) continue;
    // Mirror the pipeline's own predicate — entrambi i tagli, non solo quello
    // sul path. A file it will not extract must not mark a family stale, or the
    // panel lights up for a change no refresh can ever clear, which is worse
    // than the counter this replaced.
    if (!isSemanticMarkdown(rel)) continue;
    if (cosmeticOnlyChange(vaultDir, rel, fresh)) continue;
    const skill = rel.slice(0, rel.indexOf("/"));
    if (!existsSync(path.join(vaultDir, skill, "SKILL.md"))) continue;
    const family = skill.slice(
      0,
      skill.indexOf("-") === -1 ? skill.length : skill.indexOf("-"),
    );
    if (busy.has(family)) continue;
    const set = bySkill.get(family) ?? new Set<string>();
    set.add(skill);
    bySkill.set(family, set);
  }
  const out: StaleFamily[] = [];
  for (const [family, skills] of bySkill) {
    const sorted = [...skills].sort();
    const count = git(
      vaultDir,
      "rev-list",
      "--count",
      `${fresh}..HEAD`,
      "--",
      ...sorted,
    );
    out.push({
      family,
      skills: sorted,
      commits: count.status === 0 ? parseInt(count.stdout.trim(), 10) || 0 : 0,
      command: `graphify-refresh.py ${family}`,
    });
  }
  return out.sort(
    (a, b) => b.commits - a.commits || a.family.localeCompare(b.family),
  );
}

// The hook writes the epoch at which it will start and clears it when it wakes.
// A worker killed mid-wait leaves the marker behind — which happens for real:
// the commit comes from the dashboard's own service, so its detached worker
// sits in that service's cgroup and a restart takes it down with it. An hour of
// grace turned that into a pill stuck on "Refresh due" forever, so the marker
// only counts until shortly past its own deadline.
const ARMED_GRACE_SECONDS = 60;

function readArmed(outDir: string): number | null {
  const file = path.join(outDir, ".refresh-armed");
  if (!existsSync(file)) return null;
  const raw = parseInt(readFileSync(file, "utf8").trim(), 10);
  if (!Number.isFinite(raw)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (raw < now - ARMED_GRACE_SECONDS) return null;
  return raw;
}

export function readGraphFreshness(vaultDir: string): GraphFreshness {
  const outDir = path.join(vaultDir, "graphify-out");
  if (!existsSync(path.join(outDir, "graph.json"))) return { hasGraph: false };

  const status = readJson(path.join(outDir, ".refresh-status.json"));
  const statusObj =
    status && typeof status === "object" && !Array.isArray(status)
      ? (status as Record<string, unknown>)
      : null;

  let freshThroughCommit: string | null =
    statusObj && typeof statusObj.fresh_through_commit === "string"
      ? statusObj.fresh_through_commit
      : null;
  if (!freshThroughCommit) {
    // Fallback to the raw bookmark when status.json is missing or corrupt.
    const shaFile = path.join(outDir, ".last-refresh-sha");
    if (existsSync(shaFile)) {
      const raw = readFileSync(shaFile, "utf8").trim();
      if (raw) freshThroughCommit = raw;
    }
  }

  const updatedAt =
    statusObj && typeof statusObj.updated_at === "string"
      ? statusObj.updated_at
      : null;
  const pending = parsePending(statusObj?.pending);
  const run = parseRun(statusObj?.run);
  const commitsBehind = semanticCommitsBehind(vaultDir, freshThroughCommit);
  // A family already queued in this run, or already known to have failed, is
  // not "stale and unnoticed": it would be listed twice under two names.
  const inFlight = [
    ...(run?.families ?? []),
    ...pending.map((entry) => entry.family),
  ];
  const stale = staleFamilies(vaultDir, freshThroughCommit, inFlight);
  const armedAt = readArmed(outDir);

  return {
    hasGraph: true,
    freshThroughCommit,
    updatedAt,
    commitsBehind,
    pending,
    run,
    stale,
    armedAt,
  };
}
