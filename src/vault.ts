import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { LoomConfig } from "./config.js";

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const ARCHIVE_DIR = "archive";

export interface Skill {
  name: string;
  dir: string;
  frontmatterName: string | null;
}

export interface VaultProblem {
  kind: "invalid-name" | "name-mismatch" | "duplicate";
  name: string;
  detail: string;
}

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
