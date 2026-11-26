import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  addOp,
  archiveOp,
  bulkApply,
  bulkArchiveOp,
  bulkRestoreOp,
  bulkStatusOp,
  bulkTaxonomyOp,
  migrateOp,
  restoreOp,
  setFieldOp,
  type OpOutcome,
} from "../src/ops.js";
import { saveConfig, DEFAULT_IGNORE } from "../src/config.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

function vaultBare() {
  const vault = makeTmp();
  makeConfig(vault, {});
  return vault;
}

test("addOp dry-run touches nothing, apply scaffolds with description", () => {
  const vault = vaultBare();
  const dry = addOp(
    vault,
    "demo",
    { description: "My custom description" },
    false,
  );
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.length > 0);
  assert.ok(!existsSync(path.join(vault, "demo")));
  const wet = addOp(
    vault,
    "demo",
    { description: "My custom description" },
    true,
  );
  assert.equal(wet.status, 0);
  const md = readFileSync(path.join(vault, "demo", "SKILL.md"), "utf8");
  assert.match(md, /^name: demo$/m);
  assert.match(md, /^description: My custom description$/m);
});

test("addOp rejects invalid and duplicate names with status 2", () => {
  const vault = vaultBare();
  assert.equal(addOp(vault, "Bad_Name", {}, true).status, 2);
  addOp(vault, "twice", {}, true);
  assert.equal(addOp(vault, "twice", {}, true).status, 2);
});

test("addOp collapses newlines in description", () => {
  const vault = vaultBare();
  addOp(vault, "multiline", { description: "a\nb" }, true);
  const md = readFileSync(path.join(vault, "multiline", "SKILL.md"), "utf8");
  assert.match(md, /^description: a b$/m);
});

test("addOp on a strict-taxonomy vault: requires domain/layer, scaffolds sections", async () => {
  const { saveConfig, loadConfig } = await import("../src/config.js");
  const vault = vaultBare();
  saveConfig(vault, {
    ...loadConfig(vault),
    lint: {
      requireTaxonomy: ["domain", "layer"],
      allowedDomains: ["brand-a", "cross"],
      allowedLayers: ["tool", "engine"],
      requireSections: ["Policy"],
    },
  });
  // required taxonomy missing → refused, nothing written
  assert.equal(addOp(vault, "no-taxo", {}, true).status, 2);
  assert.ok(!existsSync(path.join(vault, "no-taxo")));
  // provided → created with uncommented taxonomy + a scaffolded Policy section
  const out = addOp(
    vault,
    "with-taxo",
    { taxonomy: { domain: "brand-a", layer: "tool" }, description: "d" },
    true,
  );
  assert.equal(out.status, 0);
  const md = readFileSync(path.join(vault, "with-taxo", "SKILL.md"), "utf8");
  assert.match(md, /^domain: brand-a$/m);
  assert.match(md, /^layer: tool$/m);
  assert.match(md, /^status: draft$/m); // new skills default to draft, not active
  assert.match(md, /^## Policy$/m);
});

test("addOp: a vault requiring status still enforces it after the taxonomy/status split", () => {
  const vault = makeTmp();
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({
      consumers: {},
      lint: { requireTaxonomy: ["status"] },
    }),
  );
  // status not given -> refused, and NOT via the "missing taxonomy" branch
  // (requireTaxonomy filters "status" out before that check runs).
  const missing = addOp(vault, "a", {}, true);
  assert.equal(missing.status, 2);
  assert.match(missing.message, /require status/);
  assert.ok(!existsSync(path.join(vault, "a")));
  // status given -> created
  const ok = addOp(vault, "b", { status: "draft" }, true);
  assert.equal(ok.status, 0);
  assert.ok(existsSync(path.join(vault, "b", "SKILL.md")));
});

test("addOp: writes declared axes in declaration order", () => {
  const vault = makeTmp();
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({
      consumers: {},
      taxonomy: { domain: {}, area: {}, kind: {} },
    }),
  );
  addOp(
    vault,
    "alpha",
    {
      taxonomy: {
        kind: "framework",
        domain: "cross",
        area: "governance-quality",
      },
    },
    true,
  );
  const md = readFileSync(path.join(vault, "alpha", "SKILL.md"), "utf8");
  assert.match(md, /domain: cross\narea: governance-quality\nkind: framework/);
});

test("addOp: rejects a flag that is not a declared axis", () => {
  const vault = makeTmp();
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({ consumers: {}, taxonomy: { domain: {} } }),
  );
  const out = addOp(vault, "alpha", { taxonomy: { layer: "tool" } }, false);
  assert.equal(out.status, 2);
  assert.match(out.message, /unknown taxonomy axis "layer"/);
});

test("bulkTaxonomyOp: accepts any declared axis and rejects others", () => {
  const vault = makeTmp();
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({
      consumers: {},
      taxonomy: { domain: {}, area: { values: ["governance-quality"] } },
    }),
  );
  mkdirSync(path.join(vault, "alpha"), { recursive: true });
  writeFileSync(
    path.join(vault, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: d\n---\n\n# alpha\n",
  );
  assert.equal(
    bulkTaxonomyOp(vault, ["alpha"], "area", "governance-quality", false)
      .status,
    0,
  );
  assert.equal(
    bulkTaxonomyOp(vault, ["alpha"], "layer", "tool", false).status,
    2,
  );
  assert.equal(
    bulkTaxonomyOp(vault, ["alpha"], "area", "nope", false).status,
    2,
  );
});

test("archiveOp and migrateOp report status 2 on missing skill", () => {
  const vault = vaultBare();
  assert.equal(archiveOp(vault, "ghost", true).status, 2);
  assert.equal(migrateOp(vault, "ghost", "new-name", true).status, 2);
});

test("archiveOp apply moves the skill to .archive without touching loom.json", () => {
  const vault = vaultBare();
  makeSkill(vault, "cat", "alpha");
  const before = readFileSync(path.join(vault, "loom.json"), "utf8");
  const out = archiveOp(vault, "alpha", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, ".archive", "alpha", "SKILL.md")));
  // Archiving is a pure move: loom.json is not rewritten.
  assert.equal(readFileSync(path.join(vault, "loom.json"), "utf8"), before);
});

test("restoreOp moves an archived skill back to the vault root and re-links it", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  makeSkill(vault, "biz", "demo");
  archiveOp(vault, "demo", true);
  assert.ok(existsSync(path.join(vault, ".archive", "demo", "SKILL.md")));

  const dry = restoreOp(vault, "demo", false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.length > 0);
  assert.ok(existsSync(path.join(vault, ".archive", "demo")));

  const wet = restoreOp(vault, "demo", true);
  assert.equal(wet.status, 0);
  assert.ok(!existsSync(path.join(vault, ".archive", "demo")));
  assert.ok(existsSync(path.join(vault, "demo", "SKILL.md")));
  assert.ok(lstatSync(path.join(rt, "demo")).isSymbolicLink());
  // loom.json never carried an archived list, so nothing to clean up there.
  const cfg = JSON.parse(readFileSync(path.join(vault, "loom.json"), "utf8"));
  assert.equal(cfg.archived, undefined);
});

test("restoreOp rejects unknown names with status 2", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  assert.equal(restoreOp(vault, "nope", true).status, 2);
});

test("setFieldOp rewrites status dry-run then apply", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "s");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: x\nstatus: draft\n---\n\n# s\n`,
  );
  const dry = setFieldOp(vault, "s", "status", "active", false);
  assert.equal(dry.status, 0);
  assert.match(readFileSync(path.join(d, "SKILL.md"), "utf8"), /status: draft/); // unchanged
  const wet = setFieldOp(vault, "s", "status", "active", true);
  assert.equal(wet.status, 0);
  assert.match(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /status: active/,
  );
  // Hardening: the old value must be gone, not just appended alongside the
  // new one — catches an append-instead-of-replace regression.
  assert.doesNotMatch(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /^status: draft$/m,
  );
});

test("setFieldOp adds a missing field", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "s");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: x\n---\n\n# s\n`,
  );
  setFieldOp(vault, "s", "domain", "bottega19", true);
  assert.match(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /domain: bottega19/,
  );
});

test("setFieldOp reports status 2 on unknown skill", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  assert.equal(setFieldOp(vault, "ghost", "status", "active", true).status, 2);
});

test("addOp scaffolds a new skill as draft", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  // Real addOp signature: (vaultDir, name, opts, apply) — the brief's example
  // passed name inside an options object, which doesn't match addOp's actual
  // signature; adapted here to call it the way every other test in this file
  // does.
  const r = addOp(vault, "fresh", { description: "a".repeat(30) }, true);
  assert.equal(r.status, 0);
  const fm = readFileSync(path.join(vault, "fresh", "SKILL.md"), "utf8");
  // No taxonomy provided and no taxonomy configured on this bare vault, so
  // addOp scaffolds the commented hint block, not an uncommented status line.
  assert.match(fm, /status: draft|# status: draft/);
});

// migrateOp/restoreOp build a synthetic Skill for planLinks(); it must carry the
// real `status` so the projection predicate (isLinked) sees it. Draft and active
// are both projected (draft rides the review ramp); idea/suspended/deprecated are
// not. If the synthetic Skill omitted status it would default to active and
// wrongly link a suspended skill — the suspended case below guards that.
test("migrateOp renaming a draft skill links it into consumers (draft is projected)", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  const dir = path.join(vault, "cat", "old-draft");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: old-draft\ndescription: test skill\nstatus: draft\n---\n\n# old-draft\n`,
  );
  const out = migrateOp(vault, "old-draft", "new-draft", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "cat", "new-draft", "SKILL.md")));
  assert.ok(lstatSync(path.join(rt, "new-draft")).isSymbolicLink());
});

test("migrateOp renaming a suspended skill does not link it into consumers", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  const dir = path.join(vault, "cat", "old-susp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: old-susp\ndescription: test skill\nstatus: suspended\n---\n\n# old-susp\n`,
  );
  const out = migrateOp(vault, "old-susp", "new-susp", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "cat", "new-susp", "SKILL.md")));
  assert.ok(!existsSync(path.join(rt, "new-susp")));
});

test("migrateOp renaming an active skill still links it into consumers", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  makeSkill(vault, "cat", "old-active");
  const out = migrateOp(vault, "old-active", "new-active", true);
  assert.equal(out.status, 0);
  assert.ok(lstatSync(path.join(rt, "new-active")).isSymbolicLink());
});

test("restoreOp restoring a draft skill links it into consumers", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  const dir = path.join(vault, "cat", "draft-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: draft-skill\ndescription: test skill\nstatus: draft\n---\n\n# draft-skill\n`,
  );
  archiveOp(vault, "draft-skill", true);
  assert.ok(
    existsSync(path.join(vault, ".archive", "draft-skill", "SKILL.md")),
  );
  const out = restoreOp(vault, "draft-skill", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "draft-skill", "SKILL.md")));
  assert.ok(lstatSync(path.join(rt, "draft-skill")).isSymbolicLink());
});

test("bulkStatusOp promotes to active (links) and demotes (unlinks)", () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const mk = (name: string, status: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\nstatus: ${status}\n---\n\n# ${name}\n`,
    );
    return d;
  };
  const draftDir = mk("draftone", "draft");
  mk("liveone", "active");
  symlinkSync(path.join(vault, "liveone"), path.join(consumerDir, "liveone"));

  // dry-run promote: plans a link, writes nothing
  const dry = bulkStatusOp(vault, ["draftone"], "active", false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.some((a) => a.includes("draftone")));
  assert.ok(!existsSync(path.join(consumerDir, "draftone")));

  // apply promote: frontmatter flips and the link appears
  bulkStatusOp(vault, ["draftone"], "active", true);
  assert.ok(lstatSync(path.join(consumerDir, "draftone")).isSymbolicLink());
  assert.match(
    readFileSync(path.join(draftDir, "SKILL.md"), "utf8"),
    /status: active/,
  );

  // apply demote: link removed
  bulkStatusOp(vault, ["liveone"], "suspended", true);
  assert.ok(!existsSync(path.join(consumerDir, "liveone")));
});

// The projection boundary is isLinked (active OR draft), not isActive. These
// four transitions are the ones an isActive-based promote/demote pair gets
// wrong: reconciling every target against the DESTINATION status fixes them all
// and makes the op idempotent (it repairs drift instead of assuming none).
function statusFixture() {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const mk = (name: string, status: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\nstatus: ${status}\n---\n\n# ${name}\n`,
    );
    return d;
  };
  return { vault, consumerDir, mk };
}

test("bulkStatusOp keeps the link when an active skill moves to draft", () => {
  const { vault, consumerDir, mk } = statusFixture();
  mk("rampup", "active");
  symlinkSync(path.join(vault, "rampup"), path.join(consumerDir, "rampup"));

  bulkStatusOp(vault, ["rampup"], "draft", true);

  assert.ok(
    lstatSync(path.join(consumerDir, "rampup")).isSymbolicLink(),
    "draft is projected, so active -> draft must not unlink",
  );
});

test("bulkStatusOp unlinks a draft skill moved to a non-projected status", () => {
  const { vault, consumerDir, mk } = statusFixture();
  mk("parked", "draft");
  symlinkSync(path.join(vault, "parked"), path.join(consumerDir, "parked"));

  bulkStatusOp(vault, ["parked"], "suspended", true);

  assert.ok(
    !existsSync(path.join(consumerDir, "parked")),
    "suspended is not projected, so the draft's link must go",
  );
});

test("bulkStatusOp links a skill promoted from idea to draft", () => {
  const { vault, consumerDir, mk } = statusFixture();
  mk("seed", "idea");

  bulkStatusOp(vault, ["seed"], "draft", true);

  assert.ok(
    lstatSync(path.join(consumerDir, "seed")).isSymbolicLink(),
    "draft is projected, so idea -> draft must link",
  );
});

test("bulkStatusOp repairs a missing link when the status does not change", () => {
  const { vault, consumerDir, mk } = statusFixture();
  mk("drifted", "active");

  const dry = bulkStatusOp(vault, ["drifted"], "active", false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.some((a) => a.includes("drifted")));
  assert.ok(
    !existsSync(path.join(consumerDir, "drifted")),
    "dry-run plans the repair without writing it",
  );

  bulkStatusOp(vault, ["drifted"], "active", true);
  assert.ok(lstatSync(path.join(consumerDir, "drifted")).isSymbolicLink());
});

test("bulkStatusOp refuses a batch with an unknown name, writing nothing", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "real");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: real\ndescription: x\nstatus: draft\n---\n\n# real\n`,
  );
  const r = bulkStatusOp(vault, ["real", "ghost"], "active", true);
  assert.equal(r.status, 2);
  assert.match(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /status: draft/, // untouched
  );
});

test("bulkStatusOp refuses a batch with a malformed skill, writing nothing", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const good = path.join(vault, "good");
  mkdirSync(good, { recursive: true });
  writeFileSync(
    path.join(good, "SKILL.md"),
    `---\nname: good\ndescription: x\nstatus: draft\n---\n\n# good\n`,
  );
  // CRLF frontmatter: scanVault reads it, but setFieldOp's exact-fence regex won't match.
  const bad = path.join(vault, "bad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(
    path.join(bad, "SKILL.md"),
    `---\r\nname: bad\r\ndescription: x\r\nstatus: draft\r\n---\r\n\r\n# bad\r\n`,
  );
  const r = bulkStatusOp(vault, ["good", "bad"], "active", true);
  assert.equal(r.status, 2);
  assert.match(
    readFileSync(path.join(good, "SKILL.md"), "utf8"),
    /status: draft/, // untouched — no partial write
  );
});

test("bulkTaxonomyOp sets a field on many; validates against allowed values", () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { allowedDomains: ["biz", "home"] },
  });
  const mk = (name: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\n---\n\n# ${name}\n`,
    );
  };
  mk("a");
  mk("b");
  // disallowed value refused, writes nothing
  const bad = bulkTaxonomyOp(vault, ["a", "b"], "domain", "nope", true);
  assert.equal(bad.status, 2);
  assert.doesNotMatch(
    readFileSync(path.join(vault, "a", "SKILL.md"), "utf8"),
    /domain:/,
  );
  // allowed value applied to both
  const ok = bulkTaxonomyOp(vault, ["a", "b"], "domain", "biz", true);
  assert.equal(ok.status, 0);
  assert.match(
    readFileSync(path.join(vault, "a", "SKILL.md"), "utf8"),
    /domain: biz/,
  );
  assert.match(
    readFileSync(path.join(vault, "b", "SKILL.md"), "utf8"),
    /domain: biz/,
  );
});

test("bulkTaxonomyOp allows any value when the vault declares no allowlist", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "a");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: a\ndescription: x\n---\n\n# a\n`,
  );
  const r = bulkTaxonomyOp(vault, ["a"], "layer", "whatever", true);
  assert.equal(r.status, 0);
  assert.match(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /layer: whatever/,
  );
});

test("bulkArchiveOp archives many; bulkRestoreOp brings them back", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const mk = (name: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\n---\n\n# ${name}\n`,
    );
  };
  mk("one");
  mk("two");
  const arch = bulkArchiveOp(vault, ["one", "two"], true);
  assert.equal(arch.status, 0);
  assert.ok(existsSync(path.join(vault, ".archive", "one", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, "one")));

  const rest = bulkRestoreOp(vault, ["one", "two"], true);
  assert.equal(rest.status, 0);
  assert.ok(existsSync(path.join(vault, "one", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, ".archive", "one")));
});

test("bulkArchiveOp refuses when a name is not in the vault, writing nothing", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "one");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: one\ndescription: x\n---\n\n# one\n`,
  );
  const r = bulkArchiveOp(vault, ["one", "ghost"], true);
  assert.equal(r.status, 2);
  assert.ok(existsSync(path.join(vault, "one"))); // untouched
});

test("bulkApply keeps applying past a failing item and reports which failed", () => {
  const op = (name: string, apply: boolean): OpOutcome =>
    apply && name === "boom"
      ? { status: 1, message: "kaboom", actions: [] }
      : { status: 0, message: "ok", actions: [`did ${name}`] };
  const out = bulkApply(["a", "boom", "c"], op, true, "done");
  assert.equal(out.status, 1);
  assert.match(out.message, /applied 2\/3/);
  assert.match(out.message, /boom: kaboom/);
});

test("bulkApply catches a thrown item and still applies the rest", () => {
  const applied: string[] = [];
  const op = (name: string, apply: boolean): OpOutcome => {
    if (apply && name === "throw") throw new Error("disk full");
    if (apply) applied.push(name);
    return { status: 0, message: "ok", actions: [] };
  };
  const out = bulkApply(["x", "throw", "y"], op, true, "done");
  assert.equal(out.status, 1);
  assert.match(out.message, /throw: disk full/);
  assert.deepEqual(applied, ["x", "y"]);
});

test("archiveOp removes a link that correctly points at the skill (#17 happy path)", () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const skillDir = makeSkill(vault, "cat", "alpha");
  const link = path.join(consumerDir, "alpha");
  symlinkSync(skillDir, link); // a legit link pointing at the skill's own dir
  const out = archiveOp(vault, "alpha", true);
  assert.equal(out.status, 0);
  // lstat (not exists): after archive the link is broken, so exists() would be
  // false even if the symlink file were still there.
  assert.equal(
    lstatSync(link, { throwIfNoEntry: false }),
    undefined,
    "a link pointing at the skill must be removed",
  );
});

test("migrateOp removes the old link that pointed at the skill (#17 happy path)", () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const skillDir = makeSkill(vault, "cat", "oldx");
  const link = path.join(consumerDir, "oldx");
  symlinkSync(skillDir, link);
  const out = migrateOp(vault, "oldx", "newx", true);
  assert.equal(out.status, 0);
  assert.equal(
    lstatSync(link, { throwIfNoEntry: false }),
    undefined,
    "the old link must be removed by migrate",
  );
});

test("archiveOp leaves a foreign same-named symlink untouched (#17)", () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const mine = path.join(vault, "shared");
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    path.join(mine, "SKILL.md"),
    `---\nname: shared\ndescription: x\n---\n\n# shared\n`,
  );
  // A different vault's dir, symlinked into the same consumer under our name.
  const foreign = path.join(makeTmp(), "shared");
  mkdirSync(foreign, { recursive: true });
  const link = path.join(consumerDir, "shared");
  symlinkSync(foreign, link);

  const out = archiveOp(vault, "shared", true);
  assert.equal(out.status, 0);
  assert.ok(
    lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(),
    "foreign symlink (wrong target) must survive archive",
  );
});

test("migrateOp leaves a foreign same-named symlink untouched (#17)", () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const mine = path.join(vault, "oldshared");
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    path.join(mine, "SKILL.md"),
    `---\nname: oldshared\ndescription: x\nstatus: draft\n---\n\n# oldshared\n`,
  );
  const foreign = path.join(makeTmp(), "oldshared");
  mkdirSync(foreign, { recursive: true });
  const link = path.join(consumerDir, "oldshared");
  symlinkSync(foreign, link);

  const out = migrateOp(vault, "oldshared", "newshared", true);
  assert.equal(out.status, 0);
  assert.ok(
    lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(),
    "foreign symlink (wrong target) must survive migrate",
  );
});

test("migrateOp rewrites only the frontmatter name, not a body 'name:' line (#18)", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const d = path.join(vault, "oldskill");
  mkdirSync(d, { recursive: true });
  // Frontmatter has NO name field; a body line starts with 'name:'.
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\ndescription: x\n---\n\nExample frontmatter block:\nname: inner-example\n`,
  );
  const out = migrateOp(vault, "oldskill", "newskill", true);
  assert.equal(out.status, 0);
  const md = readFileSync(path.join(vault, "newskill", "SKILL.md"), "utf8");
  assert.match(
    md,
    /^name: newskill$/m,
    "frontmatter should carry the new name",
  );
  assert.match(md, /^name: inner-example$/m, "body line must be preserved");
});

test("restoreOp and bulkRestoreOp reject a path-traversal name (#35b)", () => {
  const vault = vaultBare();
  assert.match(restoreOp(vault, "../../evil", true).message, /invalid/i);
  assert.match(bulkRestoreOp(vault, ["../../evil"], true).message, /invalid/i);
});

test("setFieldOp rejects a value containing a newline that would break frontmatter (#35a)", () => {
  const vault = vaultBare();
  const d = path.join(vault, "sk");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: sk\ndescription: x\n---\n\n# sk\n`,
  );
  const out = setFieldOp(
    vault,
    "sk",
    "domain",
    "biz\n---\ninjected: true",
    true,
  );
  assert.equal(out.status, 2);
  assert.doesNotMatch(
    readFileSync(path.join(d, "SKILL.md"), "utf8"),
    /injected: true/,
  );
});

test("bulkTaxonomyOp rejects a value containing a newline (#35a)", () => {
  const vault = vaultBare();
  const d = path.join(vault, "sk");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: sk\ndescription: x\n---\n\n# sk\n`,
  );
  const out = bulkTaxonomyOp(vault, ["sk"], "domain", "biz\ninjected: 1", true);
  assert.equal(out.status, 2);
});
