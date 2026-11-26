import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadConfig, resolveConsumers } from "../src/config.js";
import { scanVault, validateVault } from "../src/vault.js";
import {
  agentStatusMatrix,
  applyPlan,
  orphanAgentLinks,
  planAgentLinks,
  setSkillLinks,
} from "../src/linker.js";
import { collectDoctor } from "../src/gate.js";
import { archiveOp, migrateOp, restoreOp } from "../src/ops.js";
import { makeAgent, makeConfig, makeSkill, makeTmp } from "./helpers.js";

function setup() {
  const vault = makeTmp();
  const home = makeTmp();
  const skillsDir = path.join(home, "skills");
  const agentsDir = path.join(home, "agents");
  const cfg = makeConfig(vault, {
    claude: { path: skillsDir, agentsDir },
  });
  return { vault, skillsDir, agentsDir, cfg };
}

test("resolveConsumers: agentsDir is null unless declared, expanded when it is", () => {
  const vault = makeTmp();
  makeConfig(vault, {
    bare: "~/.bare/skills",
    claude: { path: "~/.claude/skills", agentsDir: "~/.claude/agents" },
    served: { mode: "in-place", path: "~/.openclaw/skills" },
  });
  const byName = Object.fromEntries(
    resolveConsumers(loadConfig(vault)).map((c) => [c.name, c]),
  );
  assert.equal(byName.bare.agentsDir, null);
  assert.equal(byName.served.agentsDir, null);
  assert.equal(
    byName.claude.agentsDir,
    path.join(process.env.HOME ?? "", ".claude/agents"),
  );
});

test("resolveConsumers: an empty agentsDir is dropped, not turned into a stray CWD link", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {
    claude: { path: "/tmp/s", agentsDir: "  " },
  });
  const claude = resolveConsumers(cfg).find((c) => c.name === "claude");
  assert.equal(claude?.agentsDir, null);
});

test("scanVault: a skill carries the agents it owns, named by frontmatter", () => {
  const { vault, cfg } = setup();
  const writerDir = makeSkill(vault, "cat", "skill-refactor");
  makeAgent(writerDir, "skill-writer");
  makeSkill(vault, "cat", "plain");

  const skills = scanVault(vault, cfg);
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.deepEqual(byName["skill-refactor"].agents, [
    { file: "agents/skill-writer.md", name: "skill-writer" },
  ]);
  assert.deepEqual(byName.plain.agents, []);
});

test("scanVault: an agent's identity is its frontmatter name, not its filename", () => {
  const { vault, cfg } = setup();
  const dir = makeSkill(vault, "cat", "alpha");
  makeAgent(dir, "file-stem", "declared-name");
  const [alpha] = scanVault(vault, cfg);
  assert.deepEqual(alpha.agents, [
    { file: "agents/file-stem.md", name: "declared-name" },
  ]);
});

test("validateVault: two skills shipping one agent name is a blocking duplicate", () => {
  const { vault, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "researcher");
  makeAgent(makeSkill(vault, "cat", "bravo"), "researcher");

  const problems = validateVault(scanVault(vault, cfg));
  const dup = problems.find((p) => p.kind === "agent-duplicate");
  assert.ok(dup, "expected an agent-duplicate problem");
  assert.match(dup.detail, /alpha/);
  assert.match(dup.detail, /bravo/);
});

test("validateVault: an agent with no frontmatter name cannot be identified", () => {
  const { vault, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "nameless", null);
  const problems = validateVault(scanVault(vault, cfg));
  assert.equal(problems.filter((p) => p.kind === "agent-nameless").length, 1);
});

test("validateVault: an agent name may repeat the skill name it lives in", () => {
  const { vault, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "alpha");
  const problems = validateVault(scanVault(vault, cfg));
  assert.deepEqual(problems, []);
});

test("planAgentLinks: one directory link per skill that owns agents", () => {
  const { vault, agentsDir, cfg } = setup();
  const alpha = makeSkill(vault, "cat", "alpha");
  makeAgent(alpha, "one");
  makeAgent(alpha, "two");
  makeSkill(vault, "cat", "bravo"); // no agents/ → no link at all

  const plan = planAgentLinks(scanVault(vault, cfg), cfg);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "create");
  assert.equal(plan[0].target, path.join(agentsDir, "alpha"));
  assert.equal(plan[0].source, path.join(alpha, "agents"));

  applyPlan(plan);
  assert.equal(
    readlinkSync(path.join(agentsDir, "alpha")),
    path.join(alpha, "agents"),
  );
  assert.equal(planAgentLinks(scanVault(vault, cfg), cfg)[0].action, "ok");
});

test("planAgentLinks: a consumer with no agentsDir is never linked into", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {
    codex: "~/.codex/skills",
    openclaw: { mode: "in-place", path: "~/.openclaw/skills" },
  });
  makeAgent(makeSkill(vault, "cat", "alpha"), "one");
  assert.deepEqual(planAgentLinks(scanVault(vault, cfg), cfg), []);
});

test("planAgentLinks: a non-projected skill keeps its agents out of the runtime", () => {
  const { vault, cfg } = setup();
  const dir = makeSkill(vault, "cat", "alpha");
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: alpha\nstatus: suspended\ndescription: test skill\n---\n\n# alpha\n`,
  );
  makeAgent(dir, "one");
  assert.deepEqual(planAgentLinks(scanVault(vault, cfg), cfg), []);
});

test("planAgentLinks: a wrong link is replace-stale, a real directory is a conflict", () => {
  const { vault, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "one");
  makeAgent(makeSkill(vault, "cat", "bravo"), "two");
  mkdirSync(path.join(agentsDir, "alpha"), { recursive: true });
  symlinkSync("/nonexistent/place", path.join(agentsDir, "bravo"));

  const byName = Object.fromEntries(
    planAgentLinks(scanVault(vault, cfg), cfg).map((p) => [p.skill, p.action]),
  );
  assert.deepEqual(byName, { alpha: "conflict", bravo: "replace-stale" });
});

test("orphanAgentLinks: a vault-owned link whose skill is gone; hand-written agents untouched", () => {
  const { vault, agentsDir, cfg } = setup();
  const alpha = makeSkill(vault, "cat", "alpha");
  makeAgent(alpha, "one");
  applyPlan(planAgentLinks(scanVault(vault, cfg), cfg));
  // A definition the user wrote by hand, and a link out to somewhere else:
  // neither belongs to the vault, so neither is ours to report.
  writeFileSync(path.join(agentsDir, "mine.md"), "---\nname: mine\n---\n");
  symlinkSync("/somewhere/else", path.join(agentsDir, "elsewhere"));
  assert.deepEqual(orphanAgentLinks(vault, cfg, scanVault(vault, cfg)), []);

  rmSync(alpha, { recursive: true, force: true });
  assert.deepEqual(orphanAgentLinks(vault, cfg, scanVault(vault, cfg)), [
    path.join(agentsDir, "alpha"),
  ]);
});

test("agentStatusMatrix: linked, missing, broken, foreign", () => {
  const { vault, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "one");
  makeAgent(makeSkill(vault, "cat", "bravo"), "two");
  const charlie = makeSkill(vault, "cat", "charlie");
  makeAgent(charlie, "three");
  const delta = makeSkill(vault, "cat", "delta");
  makeAgent(delta, "four");
  mkdirSync(agentsDir, { recursive: true });
  symlinkSync(
    path.join(vault, "cat", "alpha", "agents"),
    path.join(agentsDir, "alpha"),
  );
  symlinkSync("/nonexistent/place", path.join(agentsDir, "charlie"));
  symlinkSync(
    path.join(vault, "cat", "alpha", "agents"),
    path.join(agentsDir, "delta"),
  );

  const byName = Object.fromEntries(
    agentStatusMatrix(scanVault(vault, cfg), cfg).map((m) => [
      m.skill,
      m.state,
    ]),
  );
  assert.deepEqual(byName, {
    alpha: "linked",
    bravo: "missing",
    charlie: "broken",
    delta: "foreign",
  });
});

test("migrateOp: renaming a skill carries its agent link, leaving nothing stranded", () => {
  const { vault, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "", "alpha"), "one");
  applyPlan(planAgentLinks(scanVault(vault, cfg), cfg));

  assert.equal(migrateOp(vault, "alpha", "omega", true).status, 0);
  assert.equal(existsSync(path.join(agentsDir, "alpha")), false);
  assert.equal(
    readlinkSync(path.join(agentsDir, "omega")),
    path.join(vault, "omega", "agents"),
  );
});

test("archiveOp then restoreOp: the agent link goes away and comes back", () => {
  const { vault, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "", "alpha"), "one");
  applyPlan(planAgentLinks(scanVault(vault, cfg), cfg));

  assert.equal(archiveOp(vault, "alpha", true).status, 0);
  assert.equal(
    lstatSync(path.join(agentsDir, "alpha"), { throwIfNoEntry: false }),
    undefined,
  );

  assert.equal(restoreOp(vault, "alpha", true).status, 0);
  assert.equal(
    readlinkSync(path.join(agentsDir, "alpha")),
    path.join(vault, "alpha", "agents"),
  );
});

test("setSkillLinks: toggling a skill off takes its agent link with it", () => {
  const { vault, skillsDir, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "", "alpha"), "one");
  const skills = scanVault(vault, cfg);

  setSkillLinks(skills, cfg, "claude", "alpha", true, true);
  assert.ok(existsSync(path.join(skillsDir, "alpha")));
  assert.ok(existsSync(path.join(agentsDir, "alpha")));

  setSkillLinks(skills, cfg, "claude", "alpha", false, true);
  assert.equal(
    lstatSync(path.join(skillsDir, "alpha"), { throwIfNoEntry: false }),
    undefined,
  );
  assert.equal(
    lstatSync(path.join(agentsDir, "alpha"), { throwIfNoEntry: false }),
    undefined,
  );
});

test("collectDoctor: a duplicate agent name and a broken agent link block", () => {
  const { vault, agentsDir, cfg } = setup();
  makeAgent(makeSkill(vault, "cat", "alpha"), "researcher");
  makeAgent(makeSkill(vault, "cat", "bravo"), "researcher");
  mkdirSync(agentsDir, { recursive: true });
  symlinkSync("/nonexistent/place", path.join(agentsDir, "alpha"));

  const report = collectDoctor(vault);
  assert.ok(report.blocking.some((b) => b.includes("agent-duplicate")));
  assert.ok(report.blocking.some((b) => /agent .*alpha.* is broken/.test(b)));
  assert.ok(report.count >= 2);
});
