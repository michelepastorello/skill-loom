import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expandTilde, loadConfig, saveConfig } from "./config.js";
import { ARCHIVE_DIR, NAME_RE, scanVault } from "./vault.js";
import { applyPlan, planLinks } from "./linker.js";

export interface OpOutcome {
  status: 0 | 1 | 2;
  message: string;
  actions: string[];
}

const DEFAULT_DESCRIPTION = "Describe when this skill should be used";

export function addOp(
  vaultDir: string,
  name: string | undefined,
  category: string | undefined,
  description: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom add <name> [--category <dir>]",
      actions: [],
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      status: 2,
      message: `invalid skill name "${name}" — must match ${NAME_RE}`,
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  if (scanVault(vaultDir, cfg).some((s) => s.name === name)) {
    return {
      status: 2,
      message: `skill "${name}" already exists in vault`,
      actions: [],
    };
  }
  const dir = path.join(vaultDir, category ?? "", name);
  if (!path.resolve(dir).startsWith(path.resolve(vaultDir) + path.sep)) {
    return {
      status: 2,
      message: `category "${category}" escapes the vault`,
      actions: [],
    };
  }
  const mdPath = path.join(dir, "SKILL.md");
  if (!apply) {
    return {
      status: 0,
      message: `would create ${mdPath}`,
      actions: [`create ${mdPath}`],
    };
  }
  const desc = (description ?? DEFAULT_DESCRIPTION).replace(/[\r\n]+/g, " ");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    mdPath,
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
  );
  return {
    status: 0,
    message: `created ${mdPath}`,
    actions: [`create ${mdPath}`],
  };
}

export function archiveOp(
  vaultDir: string,
  name: string | undefined,
  reason: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom archive <name> [--reason <text>] [--apply]",
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const skill = scanVault(vaultDir, cfg).find((s) => s.name === name);
  if (!skill) {
    return {
      status: 2,
      message: `skill "${name}" not found in vault`,
      actions: [],
    };
  }
  const dest = path.join(vaultDir, ARCHIVE_DIR, name);
  if (existsSync(dest)) {
    return { status: 2, message: `${dest} already exists`, actions: [] };
  }
  const links = Object.values(cfg.consumers)
    .map((d) => path.join(expandTilde(d), name))
    .filter((t) => lstatSync(t, { throwIfNoEntry: false })?.isSymbolicLink());
  const actions = [
    `move ${skill.dir} -> ${dest}`,
    ...links.map((l) => `unlink ${l}`),
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  for (const l of links) unlinkSync(l);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(skill.dir, dest);
  cfg.archived.push({
    name,
    date: new Date().toISOString().slice(0, 10),
    reason: reason ?? "",
  });
  saveConfig(vaultDir, cfg);
  return {
    status: 0,
    message: `archived "${name}" (${links.length} link(s) removed)`,
    actions,
  };
}

export function migrateOp(
  vaultDir: string,
  oldName: string | undefined,
  newName: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!oldName || !newName) {
    return {
      status: 2,
      message: "usage: skill-loom migrate <old> <new> [--apply]",
      actions: [],
    };
  }
  if (!NAME_RE.test(newName)) {
    return {
      status: 2,
      message: `invalid new name "${newName}" — must match ${NAME_RE}`,
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const skill = skills.find((s) => s.name === oldName);
  if (!skill) {
    return {
      status: 2,
      message: `skill "${oldName}" not found in vault`,
      actions: [],
    };
  }
  if (skills.some((s) => s.name === newName)) {
    return {
      status: 2,
      message: `skill "${newName}" already exists in vault`,
      actions: [],
    };
  }
  const newDir = path.join(path.dirname(skill.dir), newName);
  if (existsSync(newDir)) {
    return { status: 2, message: `${newDir} already exists`, actions: [] };
  }
  const actions = [
    `rename ${skill.dir} -> ${newDir}`,
    `set SKILL.md frontmatter name: ${newName}`,
    `re-link "${newName}" in ${Object.keys(cfg.consumers).length} consumer(s)`,
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  renameSync(skill.dir, newDir);
  const mdPath = path.join(newDir, "SKILL.md");
  writeFileSync(
    mdPath,
    readFileSync(mdPath, "utf8").replace(/^name:.*$/m, `name: ${newName}`),
  );
  for (const rawDir of Object.values(cfg.consumers)) {
    const oldTarget = path.join(expandTilde(rawDir), oldName);
    if (lstatSync(oldTarget, { throwIfNoEntry: false })?.isSymbolicLink())
      unlinkSync(oldTarget);
  }
  applyPlan(
    planLinks([{ name: newName, dir: newDir, frontmatterName: newName }], cfg),
  );
  return {
    status: 0,
    message: `migrated "${oldName}" -> "${newName}"`,
    actions,
  };
}

export function restoreOp(
  vaultDir: string,
  name: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom restore <name>",
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const src = path.join(vaultDir, ARCHIVE_DIR, name);
  if (!existsSync(src)) {
    return { status: 2, message: `no archived skill "${name}"`, actions: [] };
  }
  const dest = path.join(vaultDir, name);
  if (existsSync(dest)) {
    return { status: 2, message: `${dest} already exists`, actions: [] };
  }
  const consumers = Object.keys(cfg.consumers).length;
  const actions = [
    `move ${src} -> ${dest}`,
    `re-link "${name}" into ${consumers} consumer(s)`,
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  renameSync(src, dest);
  cfg.archived = cfg.archived.filter((a) => a.name !== name);
  saveConfig(vaultDir, cfg);
  applyPlan(planLinks([{ name, dir: dest, frontmatterName: name }], cfg));
  return { status: 0, message: `restored "${name}"`, actions };
}
