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
import { resolveConsumers, type LoomConfig } from "./config.js";
import { isServed } from "./inplace.js";
import { isActive, type Skill } from "./vault.js";

export type PlanAction = "create" | "ok" | "replace-stale" | "conflict";

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

export function planLinks(skills: Skill[], cfg: LoomConfig): PlanItem[] {
  const items: PlanItem[] = [];
  for (const { name: consumer, mode, dir } of resolveConsumers(cfg)) {
    // In-place consumers read the vault directly — nothing to symlink.
    if (mode === "in-place" || dir === null) continue;
    for (const skill of skills) {
      if (!isActive(skill)) continue; // only active skills are projected
      const target = path.join(dir, skill.name);
      const source = path.resolve(skill.dir);
      const st = lstatSync(target, { throwIfNoEntry: false });
      if (!st) {
        items.push({
          consumer,
          skill: skill.name,
          source,
          target,
          action: "create",
          detail: "",
        });
      } else if (st.isSymbolicLink()) {
        const dest = resolveLink(target);
        if (dest === source) {
          items.push({
            consumer,
            skill: skill.name,
            source,
            target,
            action: "ok",
            detail: "",
          });
        } else {
          items.push({
            consumer,
            skill: skill.name,
            source,
            target,
            action: "replace-stale",
            detail: `currently -> ${dest}`,
          });
        }
      } else {
        items.push({
          consumer,
          skill: skill.name,
          source,
          target,
          action: "conflict",
          detail: "target exists and is not a symlink",
        });
      }
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
    }
  }
}

export type LinkState = "linked" | "missing" | "broken" | "foreign" | "served";

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
      if (!isActive(skill)) continue; // non-active skills are never unhealthy coverage rows
      if (inPlace) {
        items.push({
          consumer,
          skill: skill.name,
          state: active ? "served" : "missing",
        });
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
  for (const skill of targets) {
    const target = path.join(dir, skill.name);
    const source = path.resolve(skill.dir);
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (on) {
      if (!st) {
        actions.push(`link ${target}`);
        if (apply) {
          mkdirSync(dir, { recursive: true });
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
  }
  return { actions, skipped };
}
