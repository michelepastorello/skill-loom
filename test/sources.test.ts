import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import {
  listSources,
  listSourceSkills,
  sourceDir,
  sourceSkillDir,
} from "../src/sources.js";
import { makeTmp, makeConfig } from "./helpers.js";

function mkSkill(dir: string, name: string, desc = "d"): string {
  const d = path.join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`,
  );
  return d;
}

function mkPlugin(
  pluginsDir: string,
  name: string,
  skills: string[],
): Record<string, unknown> {
  const inst = path.join(makeTmp(), name, "1.0.0");
  for (const s of skills) mkSkill(path.join(inst, "skills"), s, `${name}/${s}`);
  return { [`${name}@mkt`]: [{ installPath: inst }] };
}

// A plugin that keeps its skills somewhere else and says so in its manifest.
// `declared` is written to plugin.json verbatim: a bare string names one path,
// an array names several, and either can point at a dir of skills or straight
// at a single skill.
function mkPluginAt(
  name: string,
  layout: Record<string, string[]>,
  declared: unknown,
): Record<string, unknown> {
  const inst = path.join(makeTmp(), name, "1.0.0");
  for (const [rel, skills] of Object.entries(layout))
    for (const s of skills) mkSkill(path.join(inst, rel), s, `${name}/${s}`);
  mkdirSync(path.join(inst, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(inst, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", skills: declared }),
  );
  return { [`${name}@mkt`]: [{ installPath: inst }] };
}

// One fixture standing in for the real topology: a vault, the shared npx pool
// (whose groups come from its lockfile), Claude (whose groups are its plugins
// plus the natives in its own dir), and an in-place runtime with a skills root.
function setup() {
  const vault = makeTmp();
  mkSkill(vault, "alpha");
  mkSkill(vault, "bravo");

  const agentsHome = makeTmp();
  const pool = path.join(agentsHome, "skills");
  mkdirSync(pool, { recursive: true });
  mkSkill(pool, "pool-one");
  mkSkill(pool, "pool-two");
  mkSkill(pool, "solo");
  symlinkSync(path.join(vault, "alpha"), path.join(pool, "alpha"));
  writeFileSync(
    path.join(agentsHome, ".skill-lock.json"),
    JSON.stringify({
      version: 3,
      skills: {
        "pool-one": { source: "acme/kit", sourceType: "github" },
        "pool-two": { source: "acme/kit", sourceType: "github" },
        solo: { source: "solo-dev/one", sourceType: "github" },
      },
    }),
  );

  const claudeSkills = path.join(makeTmp(), "skills");
  mkdirSync(claudeSkills, { recursive: true });
  mkSkill(claudeSkills, "native-one", "a native of the runtime");
  symlinkSync(path.join(vault, "bravo"), path.join(claudeSkills, "bravo"));

  const pluginsDir = makeTmp();
  writeFileSync(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        ...mkPlugin(pluginsDir, "ops", ["runbook", "vendor-review"]),
        ...mkPlugin(pluginsDir, "powers", ["runbook"]),
      },
    }),
  );

  const openclawSkills = path.join(makeTmp(), "skills");
  mkdirSync(openclawSkills, { recursive: true });
  mkSkill(openclawSkills, "orphan-one");

  const cfg = makeConfig(vault, {
    agents: pool,
    claude: claudeSkills,
    openclaw: { mode: "in-place", path: openclawSkills },
  });
  return { vault, cfg, pluginsDir, pool, claudeSkills };
}

const byId = (vault: string, cfg: never, pluginsDir: string) =>
  Object.fromEntries(listSources(vault, cfg, pluginsDir).map((s) => [s.id, s]));

test("listSources: one source per runtime, so a plugin is never a top-level source", () => {
  const { vault, cfg, pluginsDir } = setup();
  const ids = listSources(vault, cfg, pluginsDir).map((s) => s.id);
  assert.deepEqual(ids, ["personal", "agents", "claude", "openclaw"]);
});

test("listSources: a runtime counts every skill it holds, across all its groups", () => {
  const { vault, cfg, pluginsDir } = setup();
  const src = byId(vault, cfg as never, pluginsDir);
  assert.equal(src.personal.count, 2); // alpha, bravo
  assert.equal(src.agents.count, 3); // pool-one/two/solo; the vault symlink is skipped
  assert.equal(src.claude.count, 4); // 3 plugin skills + 1 native; bravo symlink skipped
  assert.equal(src.openclaw.count, 1); // orphan-one
});

test("listSources: the pool groups by the repo its lockfile says each skill came from", () => {
  const { vault, cfg, pluginsDir } = setup();
  const groups = byId(vault, cfg as never, pluginsDir).agents.groups;
  assert.deepEqual(
    groups.map((g) => [g.key, g.skills.map((s) => s.name)]),
    [
      ["acme/kit", ["pool-one", "pool-two"]],
      ["solo-dev/one", ["solo"]],
    ],
  );
});

test("listSources: Claude groups by plugin, and its own dir's skills are bundled by nothing", () => {
  const { vault, cfg, pluginsDir } = setup();
  const groups = byId(vault, cfg as never, pluginsDir).claude.groups;
  assert.deepEqual(
    groups.map((g) => [g.key, g.skills.map((s) => s.name)]),
    [
      ["ops", ["runbook", "vendor-review"]],
      ["powers", ["runbook"]],
      ["(unbundled)", ["native-one"]],
    ],
  );
});

test("listSources: groups come alphabetically by label, so the rail reads like an index", () => {
  const { vault, cfg, pluginsDir } = setup();
  const groups = byId(vault, cfg as never, pluginsDir).claude.groups;
  assert.deepEqual(
    groups.map((g) => g.label),
    ["ops", "powers", "Unbundled"],
  );
});

test("listSources: a pool skill the lockfile does not claim is still listed, not dropped", () => {
  const { vault, cfg, pluginsDir, pool } = setup();
  mkSkill(pool, "hand-dropped");
  const agents = byId(vault, cfg as never, pluginsDir).agents;
  // Nothing bundled it, which is the same thing the runtime's loose dirs say —
  // one concept, one key, whatever left the skill on its own.
  const unbundled = agents.groups.find((g) => g.key === "(unbundled)");
  assert.deepEqual(
    unbundled?.skills.map((s) => s.name),
    ["hand-dropped"],
  );
  assert.equal(agents.count, 4);
});

test("listSources: a runtime with no skills of its own is not offered as a source", () => {
  const vault = makeTmp();
  mkSkill(vault, "alpha");
  const empty = path.join(makeTmp(), "skills");
  mkdirSync(empty, { recursive: true });
  symlinkSync(path.join(vault, "alpha"), path.join(empty, "alpha"));
  const cfg = makeConfig(vault, { vibe: empty });
  const ids = listSources(vault, cfg, makeTmp()).map((s) => s.id);
  assert.deepEqual(ids, ["personal"]);
});

test("listSourceSkills: each skill carries the group it belongs to", () => {
  const { vault, cfg, pluginsDir } = setup();
  const skills = listSourceSkills("agents", vault, cfg, pluginsDir);
  assert.deepEqual(
    skills.map((s) => [s.name, s.group]),
    [
      ["pool-one", "acme/kit"],
      ["pool-two", "acme/kit"],
      ["solo", "solo-dev/one"],
    ],
  );
});

test("listSourceSkills reads the description from each skill's own dir", () => {
  const { vault, cfg, pluginsDir } = setup();
  const skills = listSourceSkills("claude", vault, cfg, pluginsDir);
  const native = skills.find((s) => s.name === "native-one");
  assert.equal(native?.description, "a native of the runtime");
});

test("sourceSkillDir: the group disambiguates a name two plugins both ship", () => {
  const { vault, cfg, pluginsDir } = setup();
  const a = sourceSkillDir("claude", "ops", "runbook", vault, cfg, pluginsDir);
  const b = sourceSkillDir(
    "claude",
    "powers",
    "runbook",
    vault,
    cfg,
    pluginsDir,
  );
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.ok(a.endsWith(path.join("ops", "1.0.0", "skills", "runbook")));
  assert.ok(b.endsWith(path.join("powers", "1.0.0", "skills", "runbook")));
});

test("sourceSkillDir returns null when the group does not hold that skill", () => {
  const { vault, cfg, pluginsDir } = setup();
  // vendor-review is real, but it belongs to ops, not powers.
  assert.equal(
    sourceSkillDir("claude", "powers", "vendor-review", vault, cfg, pluginsDir),
    null,
  );
  assert.equal(
    sourceSkillDir("claude", "nope", "runbook", vault, cfg, pluginsDir),
    null,
  );
  assert.equal(
    sourceSkillDir("nope", "ops", "runbook", vault, cfg, pluginsDir),
    null,
  );
});

test("sourceDir resolves a source to its dir, and an unknown one to null", () => {
  const { vault, cfg, pluginsDir, pool } = setup();
  assert.equal(sourceDir("agents", vault, cfg, pluginsDir), pool);
  assert.equal(sourceDir("plugin:ops", vault, cfg, pluginsDir), null);
});

// --- plugins that keep their skills off the beaten path ------------------------
// The plugin spec lets a manifest name extra component paths, and says they
// SUPPLEMENT the default dir rather than replace it. Seen in the wild on one
// plugin across two versions: "./.claude/skills/ui-ux-pro-max" (one skill) at
// 2.5.0, "./.claude/skills/" (a dir) at 2.11.0.

function pluginsWith(...entries: Record<string, unknown>[]): string {
  const dir = makeTmp();
  writeFileSync(
    path.join(dir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: Object.assign({}, ...entries) }),
  );
  return dir;
}

function claudeVault() {
  const vault = makeTmp();
  mkSkill(vault, "alpha");
  const skillsDir = path.join(makeTmp(), "skills");
  mkdirSync(skillsDir, { recursive: true });
  return { vault, cfg: makeConfig(vault, { claude: skillsDir }) };
}

const groupSkills = (
  vault: string,
  cfg: never,
  pluginsDir: string,
  key: string,
) =>
  listSources(vault, cfg, pluginsDir)
    .find((s) => s.id === "claude")
    ?.groups.find((g) => g.key === key)
    ?.skills.map((s) => s.name);

test("listSources: a manifest naming a skills dir is read, not just the conventional one", () => {
  const { vault, cfg } = claudeVault();
  const pluginsDir = pluginsWith(
    mkPluginAt(
      "uiux",
      { ".claude/skills": ["brand", "design"] },
      "./.claude/skills/",
    ),
  );
  assert.deepEqual(groupSkills(vault, cfg as never, pluginsDir, "uiux"), [
    "brand",
    "design",
  ]);
});

test("listSources: a manifest may name a single skill rather than a dir", () => {
  const { vault, cfg } = claudeVault();
  const pluginsDir = pluginsWith(
    mkPluginAt("uiux", { ".claude/skills": ["brand", "design"] }, [
      "./.claude/skills/brand",
    ]),
  );
  // Only the declared one: the plugin ships that skill, not its neighbours.
  assert.deepEqual(groupSkills(vault, cfg as never, pluginsDir, "uiux"), [
    "brand",
  ]);
});

test("listSources: a declared path supplements the conventional dir, never replaces it", () => {
  const { vault, cfg } = claudeVault();
  const pluginsDir = pluginsWith(
    mkPluginAt(
      "mixed",
      { skills: ["conventional"], "extra/skills": ["declared"] },
      "./extra/skills",
    ),
  );
  assert.deepEqual(groupSkills(vault, cfg as never, pluginsDir, "mixed"), [
    "conventional",
    "declared",
  ]);
});

test("sourceSkillDir: a skill resolves to its own dir, not to its group's", () => {
  const { vault, cfg } = claudeVault();
  const pluginsDir = pluginsWith(
    mkPluginAt(
      "mixed",
      { skills: ["conventional"], "extra/skills": ["declared"] },
      "./extra/skills",
    ),
  );
  // The two live in different folders under one plugin, so a group-level dir
  // would resolve one of them to a path that does not exist.
  const a = sourceSkillDir(
    "claude",
    "mixed",
    "conventional",
    vault,
    cfg,
    pluginsDir,
  );
  const b = sourceSkillDir(
    "claude",
    "mixed",
    "declared",
    vault,
    cfg,
    pluginsDir,
  );
  assert.ok(a?.endsWith(path.join("skills", "conventional")));
  assert.ok(b?.endsWith(path.join("extra", "skills", "declared")));
});

test("listSources: a manifest path that points nowhere is ignored, not fatal", () => {
  const { vault, cfg } = claudeVault();
  const pluginsDir = pluginsWith(
    mkPluginAt("broken", { skills: ["real"] }, ["./does-not-exist", 42]),
  );
  assert.deepEqual(groupSkills(vault, cfg as never, pluginsDir, "broken"), [
    "real",
  ]);
});
