import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LoomConfig } from "./config.js";
import { resolveAxes } from "./config.js";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Archive lives in a hidden dir so a runtime that reads the vault in place
// (e.g. OpenClaw's extraDirs, which skips dot-dirs) never loads archived skills.
export const ARCHIVE_DIR = ".archive";

/** An agent definition a skill ships in its own `agents/` folder. `name` is
 *  read from frontmatter because that — not the filename, not the directory —
 *  is what a runtime registers the agent under. `null` means the file declares
 *  no identity at all. */
export interface SkillAgent {
  /** Path relative to the skill folder, e.g. "agents/skill-writer.md". */
  file: string;
  name: string | null;
}

export interface Skill {
  name: string;
  dir: string;
  frontmatterName: string | null;
  // Populated by scanVault; omitted by call sites that only need name/dir for
  // link planning.
  firstH1?: string | null;
  // Lifecycle status from frontmatter (e.g. "active", "draft", "suspended").
  // Populated by scanVault, defaulting to "active"; omitted by the same
  // link-only call sites as firstH1, so isActive treats absent as active.
  status?: string;
  // The agents this skill owns, in filename order. Populated by scanVault;
  // omitted by the same link-only call sites as firstH1, where absent reads as
  // "no agents" and so projects nothing.
  agents?: SkillAgent[];
}

export interface VaultProblem {
  kind:
    | "invalid-name"
    | "name-mismatch"
    | "duplicate"
    // An agent name is a flat, runtime-wide identifier: two skills claiming the
    // same one means the runtime silently loads whichever it reads first.
    | "agent-duplicate"
    | "agent-nameless";
  name: string;
  detail: string;
}

// Hygiene signals surfaced by `doctor`. The two built-in kinds always run and
// only ever warn; the rest are opt-in via the loom.json `lint` block. Whether
// any of them fail the exit code is decided by `lint.strict`, in doctor.
export interface SkillWarning {
  kind:
    | "h1-mismatch"
    | "absolute-path"
    | "description-length"
    | "body-length"
    | "missing-section"
    | "missing-taxonomy"
    // Per-axis, so a vault that declares its own axes gets findings named after
    // them. Keeps emitting the exact strings "unknown-domain"/"unknown-layer"
    // that existing consumers parse.
    | `unknown-${string}`
    | "forbidden-pattern"
    | "prose-wall"
    | "structured-doc";
  name: string;
  detail: string;
  /** Path of the offending file, relative to the skill's own folder
   *  ("SKILL.md", "references/guide.md"). Absent for findings about the skill
   *  or the config as a whole rather than one file. */
  file?: string;
}

// Machine-specific home paths hardcoded as a dependency make a vault
// non-portable — the whole point of the vault is to clone across machines.
const ABS_PATH_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+/;

/** A markdown table's separator row — the one line a table cannot lack. */
const TABLE_SEP_RE = /^\|[\s:|-]+\|\s*$/m;

export function parseFrontmatterField(
  skillMdPath: string,
  field: string,
): string | null {
  let inFrontmatter = false;
  const prefix = `${field}:`;
  const lines = readFileSync(skillMdPath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && line.startsWith(prefix)) {
      const raw = line.slice(prefix.length).trim();
      // block scalar (folded `>` / literal `|`, optional chomp) → value on the
      // following indented lines; fold to a single line for display.
      if (/^[|>][+-]?$/.test(raw)) {
        const collected: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l.trim() === "---") break;
          if (l.trim() === "") continue;
          if (!/^\s/.test(l)) break; // dedented → next key
          collected.push(l.trim());
        }
        return collected.join(" ").replace(/\s+/g, " ").trim() || null;
      }
      return unquoteScalar(raw);
    }
  }
  return null;
}

// Unwrap a single-line YAML scalar: double-quoted (with escapes), single-quoted
// (with '' escapes), or plain (returned as-is).
function unquoteScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\/bfnrt])/g, (_, c) => {
      const map: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
      };
      return map[c] ?? c;
    });
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

export function parseFrontmatterName(skillMdPath: string): string | null {
  return parseFrontmatterField(skillMdPath, "name");
}

// First ATX H1 (`# Title`) after the frontmatter block. A skill guide's title
// should equal its name (the folder / frontmatter name); this reads it so
// `doctor` can flag a drift.
export function parseFirstH1(skillMdPath: string): string | null {
  const lines = readFileSync(skillMdPath, "utf8").split("\n");
  let inFrontmatter = false;
  let frontmatterDone = false;
  for (const line of lines) {
    if (line.trim() === "---") {
      if (!inFrontmatter && !frontmatterDone) {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        inFrontmatter = false;
        frontmatterDone = true;
        continue;
      }
    }
    if (inFrontmatter) continue;
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// Reads metadata.lint.<waiverKey>.reason from frontmatter without a YAML
// dependency, matching the line-based parsing used elsewhere here. Returns the
// reason when present and non-empty, else null. A waiver lets a skill opt out
// of one lint finding when the content is essential: `length-waiver` exempts
// bodyMaxLines (an inseparable runbook); `forbid-waiver` exempts
// forbidBodyPatterns (e.g. documented internal topology that is the skill).
export function waiverReason(
  skillMdPath: string,
  waiverKey: string,
): string | null {
  const keyRe = new RegExp(`^(\\s*)${waiverKey}:\\s*$`);
  const lines = readFileSync(skillMdPath, "utf8").split("\n");
  let inFrontmatter = false;
  // Indent of the matched waiver key, or null when not inside its block. Reading
  // reason: is scoped to lines indented deeper than the key, so a sibling
  // waiver's reason: never leaks into a key that has none of its own.
  let waiverIndent: number | null = null;
  for (const line of lines) {
    if (line.trim() === "---") {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    const km = line.match(keyRe);
    if (km) {
      waiverIndent = km[1].length;
      continue;
    }
    if (waiverIndent !== null) {
      // A non-blank line at or below the key's indent is a sibling/parent key:
      // the block is over.
      const indent = line.match(/^(\s*)\S/);
      if (indent && indent[1].length <= waiverIndent) {
        waiverIndent = null;
        continue;
      }
      const m = line.match(/^\s*reason:\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, "").trim();
        return v || null;
      }
    }
  }
  return null;
}

/** The lifecycle, stated once. The rules below (isActive / isProjectedStatus)
 *  and every consumer — the ops that write a status, the vault's own gate —
 *  read it from here or from `skill-loom schema`. Nobody keeps a second list:
 *  the second list is what drifted. */
export const STATUSES = [
  "idea",
  "draft",
  "active",
  "suspended",
  "deprecated",
] as const;

/** A skill is strictly gate-enforced, and eligible for promote/demote, only
 *  when active. Any other (or absent) status is advisory to the gate. */
export function isActive(s: Skill): boolean {
  return (s.status ?? "active") === "active";
}

/** A status is projected (symlinked / served) to runtimes when active OR draft.
 *  Draft is linked-but-advisory: it rides the review ramp — usable live before
 *  promotion to active — while idea / suspended / deprecated stay unprojected.
 *
 *  Takes the bare status because an op that is about to WRITE one has no Skill
 *  to ask yet; isLinked reads it off a skill. One rule, two entry points — the
 *  boundary is stated once so it cannot drift. */
export function isProjectedStatus(status?: string): boolean {
  const st = status ?? "active";
  return st === "active" || st === "draft";
}

export function isLinked(s: Skill): boolean {
  return isProjectedStatus(s.status);
}

export const AGENTS_DIR = "agents";

/** The agent definitions a skill folder ships, in filename order. Flat by
 *  design: a runtime that scans its agent root recursively takes identity from
 *  frontmatter alone, so nesting would buy nothing and hide collisions. */
export function scanSkillAgents(skillDir: string): SkillAgent[] {
  const dir = path.join(skillDir, AGENTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => ({
      file: `${AGENTS_DIR}/${e.name}`,
      name: parseFrontmatterName(path.join(dir, e.name)),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function scanVault(vaultDir: string, cfg: LoomConfig): Skill[] {
  const skills: Skill[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (cfg.ignore.includes(entry.name)) continue;
      if (dir === vaultDir && entry.name === ARCHIVE_DIR) continue;
      const full = path.join(dir, entry.name);
      const skillMd = path.join(full, "SKILL.md");
      if (existsSync(skillMd)) {
        skills.push({
          name: entry.name,
          dir: full,
          frontmatterName: parseFrontmatterName(skillMd),
          firstH1: parseFirstH1(skillMd),
          status: parseFrontmatterField(skillMd, "status") ?? "active",
          agents: scanSkillAgents(full),
        });
      } else {
        walk(full);
      }
    }
  };
  walk(vaultDir);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateVault(skills: Skill[]): VaultProblem[] {
  const problems: VaultProblem[] = [];
  const seen = new Map<string, Skill>();
  for (const s of skills) {
    if (!NAME_RE.test(s.name)) {
      problems.push({
        kind: "invalid-name",
        name: s.name,
        detail: `folder "${s.name}" must match ${NAME_RE}`,
      });
    }
    if (s.frontmatterName !== null && s.frontmatterName !== s.name) {
      problems.push({
        kind: "name-mismatch",
        name: s.name,
        detail: `SKILL.md name "${s.frontmatterName}" != folder "${s.name}"`,
      });
    }
    const dup = seen.get(s.name);
    if (dup) {
      problems.push({
        kind: "duplicate",
        name: s.name,
        detail: `${dup.dir} and ${s.dir}`,
      });
    } else {
      seen.set(s.name, s);
    }
  }
  // Agents project into one flat namespace per runtime, so their names have to
  // be unique across the whole vault — not just inside a skill. A collision is
  // silent at the runtime (it loads one file and says nothing), which is
  // exactly the class of loss the vault exists to make loud.
  const seenAgents = new Map<string, { skill: string; file: string }>();
  for (const s of skills) {
    for (const a of s.agents ?? []) {
      if (a.name === null) {
        problems.push({
          kind: "agent-nameless",
          name: s.name,
          detail: `${s.name}/${a.file} has no frontmatter name — a runtime cannot register it`,
        });
        continue;
      }
      const prev = seenAgents.get(a.name);
      if (prev) {
        problems.push({
          kind: "agent-duplicate",
          name: s.name,
          detail: `agent "${a.name}" is declared by both ${prev.skill}/${prev.file} and ${s.name}/${a.file}`,
        });
      } else {
        seenAgents.set(a.name, { skill: s.name, file: a.file });
      }
    }
  }
  return problems;
}

// Body line count (frontmatter and surrounding blank lines excluded).
function bodyLineCount(text: string): number {
  const lines = text.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++; // skip the closing ---
  }
  const body = lines.slice(i);
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  while (body.length && body[0].trim() === "") body.shift();
  return body.length;
}

// True when a heading whose text starts with `title` exists (any level,
// case-insensitive) — so "## Policy (use / do-not-use)" satisfies "Policy".
function hasHeading(text: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\b`, "im").test(text);
}

/** Every .md a skill owns, relative to its folder, sorted. A skill is the whole
 *  folder, not just its front page: references carry as much of the contract. */
export function skillMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith(".md")) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** True when a line is markdown structure rather than running prose. */
function isStructureLine(s: string): boolean {
  if (!s) return true;
  if (/^[#|>]/.test(s)) return true;
  if (s.startsWith("- ") || s.startsWith("* ")) return true;
  if (s.startsWith("```")) return true;
  return /^\d+\./.test(s);
}

/** Words in the longest run of unbroken prose. A wall of text is the one
 *  quality problem a reader feels instantly and no line count catches: 200
 *  short lines read fine, 90 words without a break do not. The frontmatter is
 *  excluded — a description is meant to be one dense paragraph. */
export function longestProseParagraphWords(text: string): number {
  let body = text;
  if (body.startsWith("---")) {
    const parts = body.split("---");
    if (parts.length >= 3) body = parts.slice(2).join("---");
  }
  let max = 0;
  let run = 0;
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (isStructureLine(s)) run = 0;
    else {
      run += s.split(/\s+/).filter(Boolean).length;
      if (run > max) max = run;
    }
  }
  return max;
}

// Hygiene checks that inform (and, under `lint.strict`, fail). The two built-in
// checks — H1/name drift and machine-specific paths — always run and are kept
// out of validateVault so they never touch the exit code on their own. The
// rest run only when the matching loom.json `lint` field is set.
export function skillWarnings(
  skills: Skill[],
  cfg?: LoomConfig,
): SkillWarning[] {
  const warnings: SkillWarning[] = [];
  const lint = cfg?.lint;
  // Resolved once, same as the forbid regexes below: it's config-derived, not
  // per-skill.
  const axes = resolveAxes(cfg ?? ({} as LoomConfig));
  // Compile forbidden-body regexes once; an invalid pattern is surfaced (not
  // thrown) so a config typo can't crash doctor or the dashboard.
  const forbid: { re: RegExp; src: string }[] = [];
  for (const pat of lint?.forbidBodyPatterns ?? []) {
    try {
      forbid.push({ re: new RegExp(pat), src: pat });
    } catch {
      warnings.push({
        kind: "forbidden-pattern",
        name: "(lint config)",
        detail: `invalid forbidBodyPatterns regex /${pat}/`,
      });
    }
  }
  for (const s of skills) {
    const md = path.join(s.dir, "SKILL.md");
    const body = readFileSync(md, "utf8");

    if (s.firstH1 != null && s.firstH1 !== s.name) {
      warnings.push({
        kind: "h1-mismatch",
        name: s.name,
        detail: `H1 "${s.firstH1}" != name "${s.name}"`,
      });
    }
    // File-level checks: a skill is its whole folder, so these run on every .md
    // it owns. Skill-level checks stay on SKILL.md — demanding frontmatter or a
    // canonical H1 from a reference would flag every well-formed vault.
    const pathIgnore = lint?.absolutePathIgnoreFiles ?? [];
    for (const rel of skillMarkdownFiles(s.dir)) {
      const text = readFileSync(path.join(s.dir, rel), "utf8");
      // Some documents exist to record where things live; paths are their
      // content, not their bug. Which ones is the vault's call, not ours.
      if (!pathIgnore.includes(rel)) {
        const abs = ABS_PATH_RE.exec(text);
        if (abs) {
          warnings.push({
            kind: "absolute-path",
            name: s.name,
            file: rel,
            detail: `machine-specific path "${abs[0]}"`,
          });
        }
      }
      if (lint?.proseMaxWords != null) {
        const words = longestProseParagraphWords(text);
        if (
          words > lint.proseMaxWords &&
          waiverReason(path.join(s.dir, rel), "prose-waiver") == null
        ) {
          warnings.push({
            kind: "prose-wall",
            name: s.name,
            file: rel,
            detail: `paragraph of ${words} words > ${lint.proseMaxWords}`,
          });
        }
      }
    }

    // Structured docs: fixed-shape files the vault names (e.g. a state map),
    // checked directly rather than in the file-level loop above — the file is
    // named by config, so it's addressed by path, not discovered by walking.
    for (const doc of cfg?.lint?.structuredDocs ?? []) {
      const p = path.join(s.dir, doc.file);
      // optional by design: declaring a shape must not make the doc mandatory
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      const h1 = text.split("\n").find((l) => l.startsWith("# ")) ?? "";
      if (doc.h1Prefix && !h1.startsWith(doc.h1Prefix)) {
        warnings.push({
          kind: "structured-doc",
          name: s.name,
          file: doc.file,
          detail: `H1 "${h1}" does not start with "${doc.h1Prefix}"`,
        });
      }
      if (doc.requireTable && !TABLE_SEP_RE.test(text)) {
        warnings.push({
          kind: "structured-doc",
          name: s.name,
          file: doc.file,
          detail: `no table`,
        });
      }
    }

    // Independent of the `lint` block: a vault can declare `taxonomy` alone
    // and still expect its axes validated.
    for (const axis of axes) {
      if (!axis.values?.length) continue;
      const v = parseFrontmatterField(md, axis.id);
      if (v && !axis.values.includes(v)) {
        warnings.push({
          kind: `unknown-${axis.id}`,
          name: s.name,
          detail: `${axis.id} "${v}" not in allowed set`,
        });
      }
    }

    if (!lint) continue;

    if (lint.descriptionMaxChars != null || lint.descriptionMinChars != null) {
      const desc = parseFrontmatterField(md, "description");
      // An empty or absent description must still be measured against the
      // minimum — a truthiness guard would skip exactly the worst case.
      const len = desc == null ? 0 : desc.length;
      if (lint.descriptionMaxChars != null && len > lint.descriptionMaxChars) {
        warnings.push({
          kind: "description-length",
          name: s.name,
          detail: `description ${len} chars > ${lint.descriptionMaxChars}`,
        });
      }
      if (lint.descriptionMinChars != null && len < lint.descriptionMinChars) {
        warnings.push({
          kind: "description-length",
          name: s.name,
          detail: `description ${len} chars < ${lint.descriptionMinChars}`,
        });
      }
    }
    if (lint.bodyMaxLines != null) {
      const n = bodyLineCount(body);
      if (n > lint.bodyMaxLines && waiverReason(md, "length-waiver") == null) {
        warnings.push({
          kind: "body-length",
          name: s.name,
          detail: `body ${n} lines > ${lint.bodyMaxLines}`,
        });
      }
    }
    if (waiverReason(md, "forbid-waiver") == null) {
      for (const { re, src } of forbid) {
        const m = re.exec(body);
        if (m) {
          warnings.push({
            kind: "forbidden-pattern",
            name: s.name,
            detail: `body matches forbidden /${src}/: "${m[0]}"`,
          });
        }
      }
    }
    for (const section of lint.requireSections ?? []) {
      if (!hasHeading(body, section)) {
        warnings.push({
          kind: "missing-section",
          name: s.name,
          detail: `missing "${section}" section`,
        });
      }
    }
    for (const field of lint.requireTaxonomy ?? []) {
      const v = parseFrontmatterField(md, field);
      if (v == null || v === "") {
        warnings.push({
          kind: "missing-taxonomy",
          name: s.name,
          detail: `frontmatter "${field}" is required`,
        });
      }
    }
  }
  return warnings;
}
