import { existsSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CONFIG_NAME,
  DEFAULT_IGNORE,
  expandTilde,
  saveConfig,
  type LoomConfig,
} from "../config.js";
import { ARCHIVE_DIR } from "../vault.js";

export const PRESETS: Record<string, string> = {
  claude: "~/.claude/skills",
  codex: "~/.agents/skills",
};

export function runInit(vaultDir: string): number {
  if (existsSync(path.join(vaultDir, CONFIG_NAME))) {
    console.error(`${CONFIG_NAME} already exists in ${vaultDir}`);
    return 2;
  }
  const consumers: Record<string, string> = {};
  for (const [name, dir] of Object.entries(PRESETS)) {
    if (existsSync(path.dirname(expandTilde(dir)))) consumers[name] = dir;
  }
  const cfg: LoomConfig = {
    schema: 1,
    consumers,
    ignore: [...DEFAULT_IGNORE],
    archived: [],
  };
  saveConfig(vaultDir, cfg);
  mkdirSync(path.join(vaultDir, ARCHIVE_DIR), { recursive: true });

  // A vault is a git repo. Write a .gitignore (git doesn't read loom.json's
  // ignore list) and make the vault its OWN repo — even when it sits inside a
  // larger one (e.g. the home dir), git init here roots a separate repo so sync
  // never operates on the parent and lists unrelated files.
  const gitignore = path.join(vaultDir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      ".rt/\nnode_modules/\n__pycache__/\n.venv/\n.DS_Store\n",
    );
  }
  let isRoot = false;
  const top = spawnSync(
    "git",
    ["-C", vaultDir, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
    },
  );
  if (top.status === 0) {
    try {
      isRoot = realpathSync(top.stdout.trim()) === realpathSync(vaultDir);
    } catch {
      isRoot = false;
    }
  }
  if (!isRoot) {
    const r = spawnSync("git", ["-C", vaultDir, "init", "-q", "-b", "main"], {
      encoding: "utf8",
    });
    console.log(
      r.status === 0
        ? "initialized a git repo in the vault"
        : 'could not run "git init" — do it manually in the vault',
    );
  }

  console.log(`initialized vault in ${vaultDir}`);
  const detected = Object.keys(consumers).join(", ");
  console.log(
    detected
      ? `detected consumers: ${detected}`
      : `no consumers detected — add them to ${CONFIG_NAME}`,
  );
  return 0;
}
