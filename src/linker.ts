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
import { expandTilde, type LoomConfig } from "./config.js";
import type { Skill } from "./vault.js";

export type PlanAction = "create" | "ok" | "replace-stale" | "conflict";

export interface PlanItem {
  consumer: string;
  skill: string;
  source: string;
  target: string;
  action: PlanAction;
  detail: string;
}

function resolveLink(target: string): string {
  return path.resolve(path.dirname(target), readlinkSync(target));
}

export function planLinks(skills: Skill[], cfg: LoomConfig): PlanItem[] {
  const items: PlanItem[] = [];
  for (const [consumer, rawDir] of Object.entries(cfg.consumers)) {
    const dir = expandTilde(rawDir);
    for (const skill of skills) {
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

export type LinkState = "linked" | "missing" | "broken" | "foreign";

export interface StatusItem {
  consumer: string;
  skill: string;
  state: LinkState;
}

export function statusMatrix(skills: Skill[], cfg: LoomConfig): StatusItem[] {
  const items: StatusItem[] = [];
  for (const [consumer, rawDir] of Object.entries(cfg.consumers)) {
    const dir = expandTilde(rawDir);
    for (const skill of skills) {
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
  for (const rawDir of Object.values(cfg.consumers)) {
    const dir = expandTilde(rawDir);
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
  const rawDir = cfg.consumers[consumer];
  if (rawDir === undefined) throw new Error(`unknown consumer "${consumer}"`);
  const dir = expandTilde(rawDir);
  const targets = skillName
    ? skills.filter((s) => s.name === skillName)
    : skills;
  const actions: string[] = [];
  const skipped: string[] = [];
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
