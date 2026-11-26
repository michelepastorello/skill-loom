import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  LOCAL_CONFIG_NAME,
  loadConfig,
  loadProjectionOverrides,
  projectionOf,
  saveConfig,
} from "../src/config.js";
import { UsageError } from "../src/errors.js";
import {
  agentStatusMatrix,
  overrideFindings,
  planAgentLinks,
  planLinks,
  planOrphanLinks,
  setSkillEverywhere,
  setSkillLinks,
  statusMatrix,
} from "../src/linker.js";
import { collectDoctor } from "../src/gate.js";
import { aggregateHealth } from "../src/server.js";
import { scanVault } from "../src/vault.js";
import {
  makeTmp,
  makeAgent,
  makeSkill,
  makeConfig,
  makeLocalConfig,
} from "./helpers.js";

/** A vault with one skill, and a consumer that already holds a REAL directory
 *  by the same name — a skill the runtime installed for itself. This is the
 *  collision the overrides exist for, so every test below starts here. */
function collision(extra: Record<string, string> = {}) {
  const vault = makeTmp();
  const agentsRuntime = path.join(makeTmp(), "skills");
  const consumers: Record<string, string> = {
    agents: agentsRuntime,
    ...extra,
  };
  makeConfig(vault, consumers);
  const skillDir = makeSkill(vault, "content", "copy-editing");
  mkdirSync(path.join(agentsRuntime, "copy-editing"), { recursive: true });
  return { vault, agentsRuntime, skillDir };
}

test("without an override, a runtime's own folder of the same name is a conflict that blocks", () => {
  const { vault } = collision();
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  assert.deepEqual(
    statusMatrix(skills, cfg, vault).map((m) => [m.consumer, m.state]),
    [["agents", "foreign"]],
  );
  assert.deepEqual(
    planLinks(skills, cfg).map((p) => p.action),
    ["conflict"],
  );
  const report = collectDoctor(vault);
  assert.equal(report.count, 1);
  assert.match(
    report.blocking[0],
    /consumer agents: "copy-editing" is foreign/,
  );
});

test("external hands the pair to the runtime: no plan, no finding, folder untouched", () => {
  const { vault, agentsRuntime } = collision();
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  assert.equal(projectionOf(cfg, "agents", "copy-editing"), "external");
  assert.deepEqual(
    statusMatrix(skills, cfg, vault).map((m) => m.state),
    ["external"],
  );
  // Skipped at the loop, not filtered out of a finished plan: a `conflict` row
  // here would keep showing the error the override was written to end.
  assert.deepEqual(planLinks(skills, cfg), []);
  assert.equal(collectDoctor(vault).count, 0);
  assert.ok(lstatSync(path.join(agentsRuntime, "copy-editing")).isDirectory());
});

test("external is per (runtime, skill): every other runtime still gets the link", () => {
  const other = path.join(makeTmp(), "skills");
  const { vault } = collision({ claude: other });
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  const plan = planLinks(skills, cfg);
  assert.deepEqual(
    plan.map((p) => [p.consumer, p.action]),
    [["claude", "create"]],
  );
  const states = Object.fromEntries(
    statusMatrix(skills, cfg, vault).map((m) => [m.consumer, m.state]),
  );
  assert.deepEqual(states, { agents: "external", claude: "missing" });
});

test("a skill and the agents it ships travel together under one override", () => {
  const other = path.join(makeTmp(), "skills");
  const vault = makeTmp();
  const agentsRuntime = path.join(makeTmp(), "skills");
  makeConfig(vault, {
    agents: {
      path: agentsRuntime,
      agentsDir: path.join(agentsRuntime, "..", "agents"),
    },
    claude: { path: other, agentsDir: path.join(other, "..", "agents") },
  });
  const dir = makeSkill(vault, "content", "copy-editing");
  makeAgent(dir, "proofreader");
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  assert.deepEqual(
    planAgentLinks(skills, cfg).map((p) => p.consumer),
    ["claude"],
  );
  assert.deepEqual(
    agentStatusMatrix(skills, cfg).map((m) => [m.consumer, m.state]),
    [
      ["agents", "external"],
      ["claude", "missing"],
    ],
  );
});

test("the toggles refuse an external pair instead of writing over the folder", () => {
  const { vault, agentsRuntime } = collision();
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  const one = setSkillLinks(skills, cfg, "agents", "copy-editing", true, true);
  assert.deepEqual(one.actions, []);
  assert.deepEqual(one.skipped, ['copy-editing (external in "agents")']);
  // "Link everywhere" is the one action that reaches every runtime at once —
  // the override has to hold there too.
  const all = setSkillEverywhere(skills, cfg, "copy-editing", true);
  assert.deepEqual(all.actions, []);
  assert.ok(lstatSync(path.join(agentsRuntime, "copy-editing")).isDirectory());
});

test("the external folder is never an orphan to remove", () => {
  const { vault, agentsRuntime } = collision();
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });
  const cfg = loadConfig(vault);
  assert.deepEqual(planOrphanLinks(vault, cfg, scanVault(vault, cfg)), []);
  assert.ok(lstatSync(path.join(agentsRuntime, "copy-editing")).isDirectory());
});

test("disabled keeps the name as the vault's: never linked, and a leftover link is reported", () => {
  const vault = makeTmp();
  const runtime = path.join(makeTmp(), "skills");
  makeConfig(vault, { agents: runtime });
  const dir = makeSkill(vault, "content", "private-notes");
  makeLocalConfig(vault, { agents: { "private-notes": "disabled" } });
  const cfg = loadConfig(vault);
  const skills = scanVault(vault, cfg);

  assert.deepEqual(planLinks(skills, cfg), []);
  assert.deepEqual(
    statusMatrix(skills, cfg, vault).map((m) => m.state),
    ["disabled"],
  );
  assert.deepEqual(overrideFindings(cfg, skills), []);

  // A link left from before the override is drift worth saying out loud — but
  // it is not a broken projection, so it warns rather than blocks.
  mkdirSync(runtime, { recursive: true });
  symlinkSync(dir, path.join(runtime, "private-notes"));
  const findings = overrideFindings(cfg, skills);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /disabled but still linked at/);
  const report = collectDoctor(vault);
  assert.equal(report.count, 0);
  assert.ok(report.warnings.some((w) => /disabled but still linked/.test(w)));
});

test("an override that names nothing real warns rather than passing for handled", () => {
  const vault = makeTmp();
  const runtime = path.join(makeTmp(), "skills");
  makeConfig(vault, {
    agents: runtime,
    openclaw: { mode: "in-place", path: path.join(makeTmp(), "skills") },
  });
  makeSkill(vault, "content", "real-one");
  makeLocalConfig(vault, {
    agents: { ghost: "external", "real-one": "managed" },
    nosuchruntime: { "real-one": "external" },
    openclaw: { "real-one": "disabled" },
  });
  const cfg = loadConfig(vault);
  const details = overrideFindings(cfg, scanVault(vault, cfg)).map(
    (f) => `${f.consumer}/${f.skill}: ${f.detail}`,
  );
  // "managed" written out loud is the default, not a finding.
  assert.equal(details.length, 3);
  assert.ok(
    details.some((d) => /^agents\/ghost: no skill by that name/.test(d)),
  );
  assert.ok(
    details.some((d) => /^nosuchruntime\/real-one: no runtime named/.test(d)),
  );
  assert.ok(
    details.some((d) => /^openclaw\/real-one: .*served in place/.test(d)),
  );
});

test("an overridden runtime does not hold a fully projected skill at partial", () => {
  assert.equal(aggregateHealth(["linked", "linked", "external"]), "active");
  assert.equal(aggregateHealth(["linked", "missing", "external"]), "attention");
  assert.equal(aggregateHealth(["external", "disabled"]), "inactive");
  assert.equal(aggregateHealth(["broken", "external"]), "attention");
});

test("the overlay is read from loom.local.json and never written back to loom.json", () => {
  const vault = makeTmp();
  makeConfig(vault, { agents: path.join(makeTmp(), "skills") });
  makeLocalConfig(vault, { agents: { "copy-editing": "external" } });

  const cfg = loadConfig(vault);
  assert.deepEqual(cfg.projectionOverrides, {
    agents: { "copy-editing": "external" },
  });
  // The round trip the dashboard performs on every config save. If the overlay
  // rode along, this machine's answer would land in the tracked file.
  saveConfig(vault, cfg);
  const onDisk = JSON.parse(
    readFileSync(path.join(vault, "loom.json"), "utf8"),
  );
  assert.equal("projectionOverrides" in onDisk, false);
  // ...and the local file is still the one holding it.
  assert.deepEqual(loadProjectionOverrides(vault), {
    agents: { "copy-editing": "external" },
  });
});

test("no overlay file is not an error, and an unreadable one is", () => {
  const vault = makeTmp();
  makeConfig(vault, { agents: path.join(makeTmp(), "skills") });
  assert.deepEqual(loadProjectionOverrides(vault), {});
  assert.equal(loadConfig(vault).projectionOverrides, undefined);

  // An override that fails to load silently would re-link over someone else's
  // folder and re-break the gate — the exact state it was written to prevent.
  writeFileSync(path.join(vault, LOCAL_CONFIG_NAME), "{ not json");
  assert.throws(() => loadProjectionOverrides(vault), UsageError);

  writeFileSync(
    path.join(vault, LOCAL_CONFIG_NAME),
    JSON.stringify({ projectionOverrides: { agents: { x: "extrenal" } } }),
  );
  assert.throws(
    () => loadProjectionOverrides(vault),
    /must be one of managed, external, disabled/,
  );

  writeFileSync(
    path.join(vault, LOCAL_CONFIG_NAME),
    JSON.stringify({ projectionOverrides: { agents: ["copy-editing"] } }),
  );
  assert.throws(() => loadProjectionOverrides(vault), /skill -> state/);
});
