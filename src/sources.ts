// Read-only skill sources beyond the curated vault. skill-loom manages the vault
// ("Personal"); everything else here is browse-only, so an author can read another
// collection's SKILL.md for reference.
//
// The shape is two levels, because that is how these skills actually arrive:
//
//   level 1  a runtime  — the thing that reads the skills (.agents, .claude, …)
//   level 2  a group    — what they were installed as, in one go
//
// Level 2 is never invented: every group is read from the manifest the runtime
// already keeps for itself (the pool's lockfile, Claude's plugin registry). A
// runtime with no manifest has one group holding the skills it ships itself.
//
// Only real dirs count as a runtime's own skills — symlinks are excluded, so the
// vault projected into a runtime is not counted twice.
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { resolveConsumers, type LoomConfig } from "./config.js";
import { parseFrontmatterField } from "./vault.js";

export type SourceKind = "vault" | "runtime";

/** One skill and the dir that holds it. The dir rides on the skill, not on its
 *  group: a plugin may declare extra skill paths that supplement its default
 *  dir, so two skills of one plugin can live in different folders. */
export interface SourceSkillRef {
  name: string;
  dir: string;
}

/** Skills that arrived together, under the name their manifest gives them. */
export interface SourceGroup {
  key: string;
  label: string;
  skills: SourceSkillRef[];
}

export interface Source {
  id: string; // "personal" | a consumer name ("agents", "claude", …)
  label: string;
  kind: SourceKind;
  dir: string;
  count: number;
  /** What the groups mean, for the UI's group-by control. Empty when ungrouped. */
  axis: string;
  groups: SourceGroup[];
}

export interface SourceSkill {
  name: string;
  description: string;
  modified: string; // YYYY-MM-DD
  group: string;
}

/** The group for skills no bundle brought: a dir sitting loose in a runtime's
 *  skills folder, or a pool skill the lockfile does not claim. Whatever left
 *  them on their own, the answer to "what did this arrive with" is the same —
 *  nothing — so it is one group, not one per reason.
 *
 *  Not "native": nothing here ships with the runtime. Claude does not come with
 *  `graphify`, OpenClaw does not come with `noteplan` — someone put them there.
 *
 *  Parenthesised so it can never collide with a real repo ("owner/repo") or a
 *  plugin name. */
const UNBUNDLED = "(unbundled)";

// A dir's own skills: real subdirectories (not symlinks) holding a SKILL.md.
function ownSkillDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory()) continue; // real dirs only — excludes projected links
    if (existsSync(path.join(dir, e.name, "SKILL.md"))) out.push(e.name);
  }
  return out.sort();
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Alphabetical by label: the rail is an index, and you look a name up in it.
 *  Ranking by size instead would move a group whenever one skill is added, so
 *  the place you learned to look would keep moving. Where the unbundled group
 *  goes is the client's call — it pins it. */
function order(groups: SourceGroup[]): SourceGroup[] {
  return groups
    .filter((g) => g.skills.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// The npx pool: `~/.agents/.skill-lock.json` maps every skill to the repo it was
// installed from, which is exactly the group — you rarely install just one.
function poolGroups(dir: string): SourceGroup[] {
  const lock = readJson(path.join(path.dirname(dir), ".skill-lock.json"));
  const skills =
    lock && typeof lock === "object"
      ? (lock as { skills?: Record<string, { source?: string }> }).skills
      : undefined;
  const byKey = new Map<string, string[]>();
  for (const name of ownSkillDirs(dir)) {
    // A skill the lockfile does not claim is still on disk and still readable:
    // nothing bundled it, so it joins the unbundled rather than being dropped.
    const key = skills?.[name]?.source || UNBUNDLED;
    byKey.set(key, [...(byKey.get(key) ?? []), name]);
  }
  return [...byKey].map(([key, names]) => ({
    key,
    // The repo name reads better than "owner/repo", and the owner is noise once
    // you are looking at one runtime's own list.
    label: key === UNBUNDLED ? "Unbundled" : (key.split("/")[1] ?? key),
    skills: names.map((name) => ({ name, dir })),
  }));
}

/** A plugin's skills: the conventional `skills/` dir, plus any path its manifest
 *  names. The plugin spec is explicit that custom component paths *supplement*
 *  the defaults rather than replace them, so both are read.
 *
 *  A declared path is a bare string or an array of them, and points either at a
 *  directory of skills or straight at one skill — both shapes are in the wild,
 *  the same plugin having used each across two versions. So each path is probed
 *  for a SKILL.md to tell which it is.
 *
 *  The manifest is data a plugin author wrote, so a path that climbs out of the
 *  plugin is dropped rather than followed. */
function pluginSkills(installPath: string): SourceSkillRef[] {
  const out: SourceSkillRef[] = [];
  const addDir = (dir: string) => {
    for (const name of ownSkillDirs(dir)) out.push({ name, dir });
  };
  addDir(path.join(installPath, "skills"));

  const mf = readJson(path.join(installPath, ".claude-plugin", "plugin.json"));
  const declared =
    mf && typeof mf === "object"
      ? (mf as { skills?: unknown }).skills
      : undefined;
  const paths =
    typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared
        : [];
  for (const rel of paths) {
    if (typeof rel !== "string") continue;
    const full = path.resolve(installPath, rel);
    if (full !== installPath && !full.startsWith(installPath + path.sep))
      continue;
    if (existsSync(path.join(full, "SKILL.md")))
      out.push({ name: path.basename(full), dir: path.dirname(full) });
    else addDir(full);
  }
  // A skill can be reached by both the default dir and a declared path; keep the
  // first sighting so a name resolves to one dir and one only.
  const seen = new Set<string>();
  return out
    .filter((s) => !seen.has(s.name) && seen.add(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Claude's plugins, from the registry it keeps. installPath points at the exact
// cached version, so stale versions in the cache are ignored.
function pluginGroups(pluginsDir: string): SourceGroup[] {
  const data = readJson(path.join(pluginsDir, "installed_plugins.json"));
  const plugins =
    data && typeof data === "object"
      ? (data as { plugins?: Record<string, unknown> }).plugins
      : undefined;
  if (!plugins || typeof plugins !== "object") return [];
  const out: SourceGroup[] = [];
  for (const [key, val] of Object.entries(plugins)) {
    const inst = Array.isArray(val) ? val[0] : val;
    const installPath =
      inst && typeof inst === "object"
        ? (inst as { installPath?: string }).installPath
        : undefined;
    if (!installPath) continue;
    const name = key.split("@")[0];
    out.push({ key: name, label: name, skills: pluginSkills(installPath) });
  }
  return out;
}

/** The dirs sitting loose in a runtime's skills folder: no plugin, no installer,
 *  no vault link — someone put them there by hand. */
function unbundledGroup(dir: string): SourceGroup {
  return {
    key: UNBUNDLED,
    label: "Unbundled",
    skills: ownSkillDirs(dir).map((name) => ({ name, dir })),
  };
}

// Grouping is per-runtime because each runtime's manifest is its own format.
// Without one, a runtime simply has its natives.
function groupsFor(
  name: string,
  skillsDir: string,
  pluginsDir: string,
): { axis: string; groups: SourceGroup[] } {
  if (name === "agents")
    return { axis: "Source", groups: order(poolGroups(skillsDir)) };
  if (name === "claude")
    return {
      axis: "Plugin",
      groups: order([...pluginGroups(pluginsDir), unbundledGroup(skillsDir)]),
    };
  return { axis: "", groups: order([unbundledGroup(skillsDir)]) };
}

/** Label a runtime by its dot-directory when that is really where it lives
 *  (`~/.agents/skills` → `.agents`), and by its plain name otherwise — a runtime
 *  under `~/.config/opencode/skills` is not called ".opencode". */
function runtimeLabel(name: string, skillsDir: string): string {
  const dot = `.${name}`;
  return skillsDir.split(path.sep).includes(dot) ? dot : cap(name);
}

export function claudePluginsDir(): string {
  return path.join(homedir(), ".claude", "plugins");
}

/** Every browsable source: the vault first, then one per runtime that holds
 *  skills of its own. A runtime holding nothing but projected links is dropped. */
export function listSources(
  vaultDir: string,
  cfg: LoomConfig,
  pluginsDir: string = claudePluginsDir(),
): Source[] {
  const sources: Source[] = [
    {
      id: "personal",
      label: "Personal",
      kind: "vault",
      dir: vaultDir,
      count: ownSkillDirs(vaultDir).length,
      axis: "",
      groups: [],
    },
  ];
  for (const c of resolveConsumers(cfg)) {
    if (!c.skillsDir) continue;
    const { axis, groups } = groupsFor(c.name, c.skillsDir, pluginsDir);
    const count = groups.reduce((n, g) => n + g.skills.length, 0);
    if (count === 0) continue;
    sources.push({
      id: c.name,
      label: runtimeLabel(c.name, c.skillsDir),
      kind: "runtime",
      dir: c.skillsDir,
      count,
      axis,
      groups,
    });
  }
  return sources;
}

function findSource(
  id: string,
  vaultDir: string,
  cfg: LoomConfig,
  pluginsDir: string,
): Source | undefined {
  return listSources(vaultDir, cfg, pluginsDir).find((s) => s.id === id);
}

/** Resolve a source id to its directory. Returns null for an unknown id, so
 *  callers reject it rather than reading an arbitrary path. */
export function sourceDir(
  id: string,
  vaultDir: string,
  cfg: LoomConfig,
  pluginsDir: string = claudePluginsDir(),
): string | null {
  return findSource(id, vaultDir, cfg, pluginsDir)?.dir ?? null;
}

/** The read-only skill list for a source, each skill tagged with its group. */
export function listSourceSkills(
  id: string,
  vaultDir: string,
  cfg: LoomConfig,
  pluginsDir: string = claudePluginsDir(),
): SourceSkill[] {
  const src = findSource(id, vaultDir, cfg, pluginsDir);
  if (!src) return [];
  const out: SourceSkill[] = [];
  for (const g of src.groups)
    for (const s of g.skills) {
      const md = path.join(s.dir, s.name, "SKILL.md");
      out.push({
        name: s.name,
        description: parseFrontmatterField(md, "description") ?? "",
        modified: statSync(md).mtime.toISOString().slice(0, 10),
        group: g.key,
      });
    }
  return out;
}

/** Resolve (source, group, skill) to an absolute dir, or null.
 *
 *  The group is part of the key, not decoration: two plugins can each ship a
 *  skill called `runbook`, and without the group the wrong one would open. The
 *  name is matched against the skills the group actually holds, so no crafted
 *  name can reach outside it. */
export function sourceSkillDir(
  id: string,
  group: string,
  name: string,
  vaultDir: string,
  cfg: LoomConfig,
  pluginsDir: string = claudePluginsDir(),
): string | null {
  const src = findSource(id, vaultDir, cfg, pluginsDir);
  if (!src) return null;
  if (src.groups.length === 0)
    return ownSkillDirs(src.dir).includes(name)
      ? path.join(src.dir, name)
      : null;
  const g = src.groups.find((x) => x.key === group);
  const s = g?.skills.find((x) => x.name === name);
  return s ? path.join(s.dir, s.name) : null;
}
