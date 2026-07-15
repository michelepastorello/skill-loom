import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LoomConfig } from "./config.js";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// Archive lives in a hidden dir so a runtime that reads the vault in place
// (e.g. OpenClaw's extraDirs, which skips dot-dirs) never loads archived skills.
export const ARCHIVE_DIR = ".archive";

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
}

export interface VaultProblem {
  kind: "invalid-name" | "name-mismatch" | "duplicate";
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
    | "unknown-domain"
    | "unknown-layer"
    | "forbidden-pattern";
  name: string;
  detail: string;
}

// Machine-specific home paths hardcoded as a dependency make a vault
// non-portable — the whole point of the vault is to clone across machines.
const ABS_PATH_RE = /\/(?:home|Users)\/[A-Za-z0-9._-]+/;

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
  const keyRe = new RegExp(`^\\s*${waiverKey}:\\s*$`);
  const lines = readFileSync(skillMdPath, "utf8").split("\n");
  let inFrontmatter = false;
  let underWaiver = false;
  for (const line of lines) {
    if (line.trim() === "---") {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    if (keyRe.test(line)) {
      underWaiver = true;
      continue;
    }
    if (underWaiver) {
      const m = line.match(/^\s*reason:\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, "").trim();
        return v || null;
      }
    }
  }
  return null;
}

/** A skill is projected to runtimes and strictly gate-enforced only when active.
 *  Any other (or absent) status keeps it library-only. */
export function isActive(s: Skill): boolean {
  return (s.status ?? "active") === "active";
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
    const abs = ABS_PATH_RE.exec(body);
    if (abs) {
      warnings.push({
        kind: "absolute-path",
        name: s.name,
        detail: `machine-specific path "${abs[0]}" in SKILL.md`,
      });
    }

    if (!lint) continue;

    if (lint.descriptionMaxChars != null || lint.descriptionMinChars != null) {
      const desc = parseFrontmatterField(md, "description");
      if (desc) {
        if (
          lint.descriptionMaxChars != null &&
          desc.length > lint.descriptionMaxChars
        ) {
          warnings.push({
            kind: "description-length",
            name: s.name,
            detail: `description ${desc.length} chars > ${lint.descriptionMaxChars}`,
          });
        }
        if (
          lint.descriptionMinChars != null &&
          desc.length < lint.descriptionMinChars
        ) {
          warnings.push({
            kind: "description-length",
            name: s.name,
            detail: `description ${desc.length} chars < ${lint.descriptionMinChars}`,
          });
        }
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
    if (lint.allowedDomains?.length) {
      const domain = parseFrontmatterField(md, "domain");
      if (domain && !lint.allowedDomains.includes(domain)) {
        warnings.push({
          kind: "unknown-domain",
          name: s.name,
          detail: `domain "${domain}" not in allowed set`,
        });
      }
    }
    if (lint.allowedLayers?.length) {
      const layer = parseFrontmatterField(md, "layer");
      if (layer && !lint.allowedLayers.includes(layer)) {
        warnings.push({
          kind: "unknown-layer",
          name: s.name,
          detail: `layer "${layer}" not in allowed set`,
        });
      }
    }
  }
  return warnings;
}
