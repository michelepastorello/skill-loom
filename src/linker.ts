import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import {
  isManaged,
  projectionOf,
  resolveConsumers,
  type LoomConfig,
} from "./config.js";
import { isServed } from "./inplace.js";
import { AGENTS_DIR, isLinked, type Skill } from "./vault.js";

export type PlanAction =
  "create" | "ok" | "replace-stale" | "remove-orphan" | "conflict";

export interface PlanItem {
  consumer: string;
  skill: string;
  source: string;
  target: string;
  action: PlanAction;
  detail: string;
}

export function resolveLink(target: string): string {
  return path.resolve(path.dirname(target), readlinkSync(target));
}

/** What one link needs, judged from what is on disk at `target`. Shared by the
 *  skill projection and the agent projection: both are "one symlink named after
 *  the skill", they differ only in which directory and which source folder. */
function planOne(
  consumer: string,
  skill: string,
  source: string,
  target: string,
): PlanItem {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st)
    return { consumer, skill, source, target, action: "create", detail: "" };
  if (!st.isSymbolicLink())
    return {
      consumer,
      skill,
      source,
      target,
      action: "conflict",
      detail: "target exists and is not a symlink",
    };
  const dest = resolveLink(target);
  if (dest === source)
    return { consumer, skill, source, target, action: "ok", detail: "" };
  return {
    consumer,
    skill,
    source,
    target,
    action: "replace-stale",
    detail: `currently -> ${dest}`,
  };
}

export function planLinks(skills: Skill[], cfg: LoomConfig): PlanItem[] {
  const items: PlanItem[] = [];
  for (const { name: consumer, mode, dir } of resolveConsumers(cfg)) {
    // In-place consumers read the vault directly — nothing to symlink.
    if (mode === "in-place" || dir === null) continue;
    for (const skill of skills) {
      if (!isLinked(skill)) continue; // active + draft skills are projected
      // Skipped here rather than filtered out of the finished plan: planOne
      // reports a real directory as `conflict`, and an external pair would sit
      // in every plan forever as the error it was declared not to be.
      if (!isManaged(cfg, consumer, skill.name)) continue;
      items.push(
        planOne(
          consumer,
          skill.name,
          path.resolve(skill.dir),
          path.join(dir, skill.name),
        ),
      );
    }
  }
  return items;
}

/** The agent projection: `<agentsDir>/<skill>` -> `<skill>/agents`.
 *
 *  One link per skill rather than one per agent file, because a runtime scans
 *  its agent root recursively and identifies each definition by its frontmatter
 *  `name` — the folder is only a container. So a skill that adds a second agent
 *  needs no new link, and the projection never has to be re-planned per file.
 *  Skills with no `agents/` folder produce nothing, which is why a vault that
 *  ships no agents links exactly as it did before. */
export function planAgentLinks(skills: Skill[], cfg: LoomConfig): PlanItem[] {
  const items: PlanItem[] = [];
  for (const { name: consumer, mode, agentsDir } of resolveConsumers(cfg)) {
    if (mode === "in-place" || agentsDir === null) continue;
    for (const skill of skills) {
      if (!isLinked(skill)) continue;
      if (!skill.agents?.length) continue;
      // A skill and the agents it ships travel together, so one override
      // governs both roots: half-projecting would leave agents answering in a
      // runtime that reads someone else's skill by that name.
      if (!isManaged(cfg, consumer, skill.name)) continue;
      items.push(
        planOne(
          consumer,
          skill.name,
          path.join(path.resolve(skill.dir), AGENTS_DIR),
          path.join(agentsDir, skill.name),
        ),
      );
    }
  }
  return items;
}

export function applyPlan(items: PlanItem[]): void {
  for (const item of items) {
    if (item.action === "create") {
      mkdirSync(path.dirname(item.target), { recursive: true });
      symlinkSync(item.source, item.target);
    } else if (item.action === "replace-stale") {
      unlinkSync(item.target);
      symlinkSync(item.source, item.target);
    } else if (item.action === "remove-orphan") {
      unlinkSync(item.target);
    }
  }
}

export type LinkState =
  | "linked"
  | "missing"
  | "broken"
  | "foreign"
  | "served"
  | "external"
  | "disabled";

export interface StatusItem {
  consumer: string;
  skill: string;
  state: LinkState;
}

export function statusMatrix(
  skills: Skill[],
  cfg: LoomConfig,
  vaultDir: string,
): StatusItem[] {
  const items: StatusItem[] = [];
  for (const { name: consumer, mode, dir, servedVia } of resolveConsumers(
    cfg,
  )) {
    const inPlace = mode === "in-place" || dir === null;
    // An in-place consumer serves every skill (read straight from the vault).
    // With a servedVia config we can check live activation; otherwise assume on.
    const active =
      inPlace && servedVia ? isServed(vaultDir, servedVia) : inPlace;
    for (const skill of skills) {
      if (!isLinked(skill)) continue; // idea/suspended/deprecated are never coverage rows
      if (inPlace) {
        items.push({
          consumer,
          skill: skill.name,
          state: active ? "served" : "missing",
        });
        continue;
      }
      // An overridden pair reports what it is instead of what is on disk: the
      // folder in the runtime is the runtime's own (external) or the absence
      // is the point (disabled). Reading disk here is how it became `foreign`.
      const owner = projectionOf(cfg, consumer, skill.name);
      if (owner !== "managed") {
        items.push({ consumer, skill: skill.name, state: owner });
        continue;
      }
      const target = path.join(dir, skill.name);
      const st = lstatSync(target, { throwIfNoEntry: false });
      let state: LinkState;
      if (!st) {
        state = "missing";
      } else if (st.isSymbolicLink()) {
        const dest = resolveLink(target);
        if (!existsSync(dest)) state = "broken";
        else if (dest === path.resolve(skill.dir)) state = "linked";
        else state = "foreign";
      } else {
        state = "foreign";
      }
      items.push({ consumer, skill: skill.name, state });
    }
  }
  return items;
}

export function orphanLinks(
  vaultDir: string,
  cfg: LoomConfig,
  skills: Skill[],
): string[] {
  const valid = new Set(skills.map((s) => path.resolve(s.dir)));
  const vaultPrefix = path.resolve(vaultDir) + path.sep;
  const orphans: string[] = [];
  for (const { mode, dir } of resolveConsumers(cfg)) {
    // In-place consumers have no managed directory to scan for stray links.
    if (mode === "in-place" || dir === null) continue;
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const target = path.join(dir, entry);
      const st = lstatSync(target, { throwIfNoEntry: false });
      if (!st || !st.isSymbolicLink()) continue;
      const dest = resolveLink(target);
      if (dest.startsWith(vaultPrefix) && !valid.has(dest))
        orphans.push(target);
    }
  }
  return orphans.sort();
}

/** Plans removal only for symlinks owned by this vault whose source no longer
 * exists as a projected skill or agent folder. Real copies and external links
 * never enter orphanLinks/orphanAgentLinks, so they remain untouched. */
export function planOrphanLinks(
  vaultDir: string,
  cfg: LoomConfig,
  skills: Skill[],
): PlanItem[] {
  return [
    ...orphanLinks(vaultDir, cfg, skills),
    ...orphanAgentLinks(vaultDir, cfg, skills),
  ]
    .sort()
    .map((target) => ({
      consumer: "",
      skill: path.basename(target),
      source: resolveLink(target),
      target,
      action: "remove-orphan" as const,
      detail: "source removed from vault",
    }));
}

/** Every link this vault owns for one skill: the skill link in each consumer's
 *  skills root, plus the agent link in each agent root. Filtered to links that
 *  actually resolve into this skill's folder — a foreign same-named link belongs
 *  to someone else and is never ours to remove. Used when a skill leaves its
 *  place (archive, migrate), where forgetting the agent link would strand it. */
export function ownedLinks(
  cfg: LoomConfig,
  skillName: string,
  skillDir: string,
): string[] {
  const source = path.resolve(skillDir);
  const agentSource = path.join(source, AGENTS_DIR);
  const candidates: [string, string][] = [];
  for (const { dir, agentsDir } of resolveConsumers(cfg)) {
    if (dir !== null) candidates.push([path.join(dir, skillName), source]);
    if (agentsDir !== null)
      candidates.push([path.join(agentsDir, skillName), agentSource]);
  }
  return candidates
    .filter(([target, expected]) => {
      const st = lstatSync(target, { throwIfNoEntry: false });
      return st?.isSymbolicLink() && resolveLink(target) === expected;
    })
    .map(([target]) => target);
}

export interface OverrideFinding {
  consumer: string;
  skill: string;
  detail: string;
}

/** What the projection overrides say that the vault cannot honour.
 *
 *  An override is the one piece of configuration whose whole job is to make a
 *  finding go away, so an override that names nothing real is the most
 *  expensive kind of typo: it looks like the problem was declared handled
 *  while the problem is still there under a name nobody matched. All of these
 *  are warnings — none of them is a broken projection, and the vault the
 *  overlay describes may legitimately be ahead of it. */
export function overrideFindings(
  cfg: LoomConfig,
  skills: Skill[],
): OverrideFinding[] {
  const overrides = cfg.projectionOverrides;
  if (!overrides) return [];
  const consumers = new Map(resolveConsumers(cfg).map((c) => [c.name, c]));
  const byName = new Map(skills.map((s) => [s.name, s]));
  const out: OverrideFinding[] = [];
  for (const [consumer, entries] of Object.entries(overrides)) {
    const resolved = consumers.get(consumer);
    for (const [skill, state] of Object.entries(entries)) {
      if (state === "managed") continue; // the default, written out loud
      if (!resolved) {
        out.push({ consumer, skill, detail: `no runtime named "${consumer}"` });
        continue;
      }
      if (resolved.mode === "in-place" || resolved.dir === null) {
        out.push({
          consumer,
          skill,
          detail: `"${consumer}" is served in place — it reads the whole vault through its own config, so a per-skill override cannot hold it back`,
        });
        continue;
      }
      const found = byName.get(skill);
      if (!found) {
        out.push({ consumer, skill, detail: "no skill by that name" });
        continue;
      }
      // Only `disabled` claims the name is the vault's, so only `disabled` can
      // leave a link of ours behind. An `external` folder is someone else's by
      // definition and ownedLinks would never return it anyway.
      if (state === "disabled") {
        for (const target of ownedLinks(cfg, skill, found.dir))
          if (
            target.startsWith(resolved.dir + path.sep) ||
            (resolved.agentsDir !== null &&
              target.startsWith(resolved.agentsDir + path.sep))
          )
            out.push({
              consumer,
              skill,
              detail: `disabled but still linked at ${target}`,
            });
      }
    }
  }
  return out;
}

function linkState(target: string, source: string): LinkState {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return "missing";
  if (!st.isSymbolicLink()) return "foreign";
  const dest = resolveLink(target);
  if (!existsSync(dest)) return "broken";
  return dest === source ? "linked" : "foreign";
}

/** Health of the agent projection, one row per (consumer, skill-that-owns-agents).
 *  Skills with no `agents/` folder are absent rather than "missing": there is
 *  nothing for them to be missing from. */
export function agentStatusMatrix(
  skills: Skill[],
  cfg: LoomConfig,
): StatusItem[] {
  const items: StatusItem[] = [];
  for (const { name: consumer, mode, agentsDir } of resolveConsumers(cfg)) {
    if (mode === "in-place" || agentsDir === null) continue;
    for (const skill of skills) {
      if (!isLinked(skill)) continue;
      if (!skill.agents?.length) continue;
      const owner = projectionOf(cfg, consumer, skill.name);
      if (owner !== "managed") {
        items.push({ consumer, skill: skill.name, state: owner });
        continue;
      }
      items.push({
        consumer,
        skill: skill.name,
        state: linkState(
          path.join(agentsDir, skill.name),
          path.join(path.resolve(skill.dir), AGENTS_DIR),
        ),
      });
    }
  }
  return items;
}

/** Links in an agent root that point into the vault but no longer name a skill
 *  that owns agents — what a rename or a dropped `agents/` folder leaves behind.
 *  Definitions the user wrote by hand, and links pointing anywhere else, are
 *  none of the vault's business and are never reported. */
export function orphanAgentLinks(
  vaultDir: string,
  cfg: LoomConfig,
  skills: Skill[],
): string[] {
  const valid = new Set(
    skills
      .filter((s) => s.agents?.length)
      .map((s) => path.join(path.resolve(s.dir), AGENTS_DIR)),
  );
  const vaultPrefix = path.resolve(vaultDir) + path.sep;
  const orphans: string[] = [];
  for (const { mode, agentsDir } of resolveConsumers(cfg)) {
    if (mode === "in-place" || agentsDir === null) continue;
    if (!existsSync(agentsDir)) continue;
    for (const entry of readdirSync(agentsDir)) {
      const target = path.join(agentsDir, entry);
      const st = lstatSync(target, { throwIfNoEntry: false });
      if (!st || !st.isSymbolicLink()) continue;
      const dest = resolveLink(target);
      if (dest.startsWith(vaultPrefix) && !valid.has(dest))
        orphans.push(target);
    }
  }
  return orphans.sort();
}

export interface ToggleResult {
  actions: string[];
  skipped: string[];
}

export function setSkillLinks(
  skills: Skill[],
  cfg: LoomConfig,
  consumer: string,
  skillName: string | null,
  on: boolean,
  apply: boolean,
): ToggleResult {
  const resolved = resolveConsumers(cfg).find((c) => c.name === consumer);
  if (resolved === undefined) throw new Error(`unknown consumer "${consumer}"`);
  const targets = skillName
    ? skills.filter((s) => s.name === skillName)
    : skills;
  const actions: string[] = [];
  const skipped: string[] = [];
  if (resolved.mode === "in-place" || resolved.dir === null) {
    // Served in place via the runtime's own config — no per-skill links exist.
    for (const skill of targets)
      skipped.push(`${skill.name} (in-place consumer "${consumer}")`);
    return { actions, skipped };
  }
  const dir = resolved.dir;
  const toggle = (target: string, source: string): void => {
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (on) {
      if (!st) {
        actions.push(`link ${target}`);
        if (apply) {
          mkdirSync(path.dirname(target), { recursive: true });
          symlinkSync(source, target);
        }
      } else if (st.isSymbolicLink() && resolveLink(target) !== source) {
        actions.push(`relink ${target}`);
        if (apply) {
          unlinkSync(target);
          symlinkSync(source, target);
        }
      } else if (!st.isSymbolicLink()) {
        skipped.push(`${target} (a real copy, not a link)`);
      }
    } else {
      if (st && st.isSymbolicLink() && resolveLink(target) === source) {
        actions.push(`unlink ${target}`);
        if (apply) unlinkSync(target);
      } else if (st) {
        skipped.push(`${target} (not a loom link)`);
      }
    }
  };
  for (const skill of targets) {
    // "Link everywhere" and the promotion that follows a status change both
    // land here, so the override has to hold at the toggle too — otherwise the
    // one action that reaches every runtime is the one that breaks the pair
    // that was declared not ours.
    const owner = projectionOf(cfg, consumer, skill.name);
    if (owner !== "managed") {
      skipped.push(`${skill.name} (${owner} in "${consumer}")`);
      continue;
    }
    const source = path.resolve(skill.dir);
    toggle(path.join(dir, skill.name), source);
    // A skill and the agents it ships travel together: unlinking only the skill
    // would leave its agents answering in a runtime that no longer has it.
    if (resolved.agentsDir !== null && skill.agents?.length)
      toggle(
        path.join(resolved.agentsDir, skill.name),
        path.join(source, AGENTS_DIR),
      );
  }
  return { actions, skipped };
}

/** Link one skill into every symlink consumer at once (the "Link everywhere"
 *  action). In-place consumers are vault-level (served via their own config),
 *  not per-skill, so they are skipped. on=true is idempotent for already-linked. */
export function setSkillEverywhere(
  skills: Skill[],
  cfg: LoomConfig,
  skillName: string,
  apply: boolean,
): ToggleResult {
  const actions: string[] = [];
  const skipped: string[] = [];
  for (const { name: consumer, mode, dir } of resolveConsumers(cfg)) {
    if (mode === "in-place" || dir === null) continue; // vault-level, not per-skill
    const r = setSkillLinks(skills, cfg, consumer, skillName, true, apply);
    actions.push(...r.actions);
    skipped.push(...r.skipped);
  }
  return { actions, skipped };
}
