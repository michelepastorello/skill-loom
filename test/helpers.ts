import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_IGNORE,
  LOCAL_CONFIG_NAME,
  saveConfig,
  type ConsumerValue,
  type LoomConfig,
  type ProjectionOverrides,
} from "../src/config.js";

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

/** An agent definition inside a skill's `agents/` folder. `frontmatterName`
 *  defaults to the file stem; pass null to write a file with no `name:` at all,
 *  which is what a runtime cannot identify. */
export function makeAgent(
  skillDir: string,
  file: string,
  frontmatterName: string | null | undefined = file,
): string {
  const dir = path.join(skillDir, "agents");
  mkdirSync(dir, { recursive: true });
  const front =
    frontmatterName === null
      ? `---\ndescription: test agent\n---\n`
      : `---\nname: ${frontmatterName}\ndescription: test agent\n---\n`;
  const p = path.join(dir, `${file}.md`);
  writeFileSync(p, `${front}\n# ${file}\n`);
  return p;
}

export function makeConfig(
  vaultDir: string,
  consumers: Record<string, ConsumerValue>,
): LoomConfig {
  const cfg: LoomConfig = {
    schema: 1,
    consumers,
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  saveConfig(vaultDir, cfg);
  return cfg;
}

/** Write the machine-local overlay beside loom.json. Returns nothing: the
 *  point of the file is that `loadConfig` picks it up, so a test that wants
 *  the overrides in play reloads the config rather than being handed one. */
export function makeLocalConfig(
  vaultDir: string,
  projectionOverrides: ProjectionOverrides,
): void {
  writeFileSync(
    path.join(vaultDir, LOCAL_CONFIG_NAME),
    JSON.stringify({ projectionOverrides }, null, 2) + "\n",
  );
}
