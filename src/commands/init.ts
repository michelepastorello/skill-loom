import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CONFIG_NAME,
  DEFAULT_IGNORE,
  expandTilde,
  saveConfig,
  type LoomConfig,
  type LintConfig,
} from "../config.js";
import { ARCHIVE_DIR } from "../vault.js";

// Known global skills directories, one per coding agent, as documented by
// the open agent-skills ecosystem (vercel-labs/skills). "agents" is the
// shared pool several agents read (Cline, Warp, Zed, ...). init adds the
// ones whose parent directory exists on this machine; the dashboard offers
// the rest as one-click suggestions.
export const PRESETS: Record<string, string> = {
  agents: "~/.agents/skills",
  claude: "~/.claude/skills",
  codex: "~/.codex/skills",
  cursor: "~/.cursor/skills",
  opencode: "~/.config/opencode/skills",
  gemini: "~/.gemini/skills",
  amp: "~/.config/agents/skills",
  windsurf: "~/.codeium/windsurf/skills",
  goose: "~/.config/goose/skills",
  vibe: "~/.vibe/skills",
};

// True only when vaultDir is the top level of its own git repo (not merely
// nested inside a larger one).
function isRepoRoot(vaultDir: string): boolean {
  const out = spawnSync(
    "git",
    ["-C", vaultDir, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (out.status !== 0) return false;
  try {
    return realpathSync(out.stdout.trim()) === realpathSync(vaultDir);
  } catch {
    return false;
  }
}

/** What a brand-new vault starts with.
 *
 *  Deliberately neutral. skill-loom is a public tool: shipping domains, layers
 *  or required sections would impose one vault's taxonomy on everyone. What
 *  ships is the shape plus the floors any vault wants — a description that
 *  actually describes, a body that is not a wall — and advisory, so a fresh
 *  vault does not open already failing. The owner tightens from here. */
export const DEFAULT_LINT: LintConfig = {
  strict: false,
  descriptionMinChars: 40,
  descriptionMaxChars: 400,
  bodyMaxLines: 200,
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
    names: {},
    lint: { ...DEFAULT_LINT },
  };
  mkdirSync(path.join(vaultDir, ARCHIVE_DIR), { recursive: true });

  // A vault is a git repo. Write a .gitignore (git doesn't read loom.json's
  // ignore list) and make the vault its OWN repo — even when it sits inside a
  // larger one (e.g. the home dir), git init here roots a separate repo so sync
  // never operates on the parent and lists unrelated files.
  const SECRET_IGNORES = [
    ".env",
    ".env.*",
    "credentials/",
    "*.sqlite",
    "*.sqlite-*",
  ];
  const gitignore = path.join(vaultDir, ".gitignore");
  if (!existsSync(gitignore)) {
    // `sync --apply` does `git add -A`, so anything a tool-skill drops into the
    // vault (a .env, a *.sqlite, a credentials/ dir) would be committed and
    // pushed unless ignored here — git never reads loom.json's ignore list.
    writeFileSync(
      gitignore,
      [
        "# Secrets & local state — the vault is committed and pushed.",
        ...SECRET_IGNORES,
        "",
        "# Build artifacts & caches",
        ".rt/",
        "node_modules/",
        "__pycache__/",
        "*.pyc",
        ".venv/",
        "",
        "# Editor / OS noise",
        ".DS_Store",
        ".vscode/",
        ".idea/",
        "",
      ].join("\n"),
    );
  } else {
    // A .gitignore already exists — make sure it still ignores secrets, or a
    // tool-skill's .env / credentials/ could be committed and pushed on sync.
    const existing = readFileSync(gitignore, "utf8");
    const present = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = SECRET_IGNORES.filter((p) => !present.has(p));
    if (missing.length) {
      const sep = existing.length && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(
        gitignore,
        existing +
          sep +
          "\n# Secrets (added by skill-loom init)\n" +
          missing.join("\n") +
          "\n",
      );
    }
  }

  // A starter CONVENTIONS.md so a fresh vault documents how its skills are
  // structured — the rules the dashboard surfaces and the loom.json `lint`
  // block enforces. Edit freely; skill-loom never rewrites it.
  const conventions = path.join(vaultDir, "CONVENTIONS.md");
  if (!existsSync(conventions)) {
    writeFileSync(
      conventions,
      [
        "# Vault conventions",
        "",
        "How skills in this vault are structured. Edit this to fit your project —",
        "the `lint` block in `loom.json` can turn the mechanical parts into checks",
        "(`skill-loom doctor`).",
        "",
        "## Structure",
        "",
        "- One folder per skill; the folder name **is** the skill name.",
        "- Each skill has a `SKILL.md` whose frontmatter `name:` and H1 both equal",
        "  the folder name.",
        "- Long material goes in `references/`, one file per topic, loaded on demand.",
        "",
        "## Frontmatter taxonomy",
        "",
        "- `domain` — who the skill belongs to (a brand, a project, `cross`).",
        "- `layer` — what kind of work it does (e.g. `tool`, `engine`, `review`).",
        "- `status` — `active` (default) or `suspended`.",
        "",
        "## Naming",
        "",
        "- Folders and files: lowercase-kebab-case.",
        "- `description` is trigger-first and concise — it is what agents read to",
        "  decide when to use the skill.",
        "",
        "## Enforcement",
        "",
        "The `lint` block in `loom.json` turns these into checks. Set",
        '`"strict": true` to fail on violations in CI or a pre-commit hook.',
        "",
      ].join("\n"),
    );
  }
  // A starter source-registry.yaml so the Rules view has the second governance
  // doc from the first run, and the format is self-documenting. Optional: it
  // only earns its keep when several skills point at the same relocatable
  // location (a data dir, another repo) via `metadata.sources`. Delete it when
  // skills are self-contained.
  const registry = path.join(vaultDir, "source-registry.yaml");
  if (!existsSync(registry)) {
    writeFileSync(
      registry,
      [
        "# Source registry (optional).",
        "# One place for shared, relocatable locations several skills point at",
        "# (a data directory, another repo, an external system). A skill names a",
        "# source id in its frontmatter (metadata.sources); the path lives here, so",
        "# moving it is a one-line edit here, not an edit in every skill.",
        "# Delete this file if your skills are self-contained.",
        "#",
        "# stability: canonical | collection | volatile | external | historical",
        "",
        "roots: {}",
        "# roots:",
        "#   project:",
        "#     path: ../my-project",
        "",
        "sources: {}",
        "# sources:",
        "#   design-tokens:",
        "#     root: project",
        "#     locator: packages/tokens",
        "#     stability: canonical",
        "",
      ].join("\n"),
    );
  }

  // Write loom.json last: it is the re-entry guard (init exits 2 if it already
  // exists), so persisting it only after the fallible mkdir/writeFile scaffold
  // steps means a mid-init failure leaves nothing behind and init can simply be
  // re-run, instead of getting stuck "already exists" on a half-built vault. It
  // still lands before the git add/commit below, so it is committed.
  saveConfig(vaultDir, cfg);

  const isRoot = isRepoRoot(vaultDir);
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

  // Commit the scaffold so a fresh vault opens clean instead of showing its own
  // config files as "unsaved changes". Only when the vault is now the root of
  // its OWN repo — never commit into a parent repo (git init above reroots a
  // nested dir, so the success path is safe; guard the failure path). --no-verify
  // skips any hook inherited from an enclosing config.
  // Already root, or made root by the git init above — only the latter needs a
  // re-check, so short-circuit the redundant second rev-parse when isRoot held.
  const ownRepo = isRoot || isRepoRoot(vaultDir);
  if (ownRepo) {
    spawnSync("git", ["-C", vaultDir, "add", "-A"], { encoding: "utf8" });
    const commit = spawnSync(
      "git",
      ["-C", vaultDir, "commit", "-m", "loom: initialize vault", "--no-verify"],
      { encoding: "utf8" },
    );
    if (commit.status === 0)
      console.log("committed the initial vault scaffold");
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
