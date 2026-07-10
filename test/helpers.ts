import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_IGNORE, saveConfig, type LoomConfig } from "../src/config.js";

export function makeTmp(): string {
  return mkdtempSync(path.join(tmpdir(), "loom-test-"));
}

export function makeSkill(
  vaultDir: string,
  category: string,
  name: string,
  frontmatterName: string = name,
): string {
  const dir = path.join(vaultDir, category, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: test skill\n---\n\n# ${name}\n`,
  );
  return dir;
}

export function makeConfig(
  vaultDir: string,
  consumers: Record<string, string>,
): LoomConfig {
  const cfg: LoomConfig = {
    schema: 1,
    consumers,
    ignore: [...DEFAULT_IGNORE],
    archived: [],
    names: {},
  };
  saveConfig(vaultDir, cfg);
  return cfg;
}
