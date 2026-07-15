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
  bulkArchiveOp,
  bulkRenameOp,
  bulkRestoreOp,
  bulkStatusOp,
  bulkTaxonomyOp,
  migrateOp,
  restoreOp,
  setFieldOp,
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
    { domain: "brand-a", layer: "tool", description: "d" },
    true,
  );
  assert.equal(out.status, 0);
  const md = readFileSync(path.join(vault, "with-taxo", "SKILL.md"), "utf8");
  assert.match(md, /^domain: brand-a$/m);
  assert.match(md, /^layer: tool$/m);
  assert.match(md, /^status: draft$/m); // new skills default to draft, not active
  assert.match(md, /^## Policy$/m);
});

test("archiveOp and migrateOp report status 2 on missing skill", () => {
  const vault = vaultBare();
  assert.equal(archiveOp(vault, "ghost", undefined, true).status, 2);
  assert.equal(migrateOp(vault, "ghost", "new-name", true).status, 2);
});

test("archiveOp apply moves the skill to .archive without touching loom.json", () => {
  const vault = vaultBare();
  makeSkill(vault, "cat", "alpha");
  const before = readFileSync(path.join(vault, "loom.json"), "utf8");
  const out = archiveOp(vault, "alpha", "superseded", true);
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
  archiveOp(vault, "demo", "obsolete", true);
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

// Regression: migrateOp/restoreOp used to build a synthetic Skill for
// planLinks() that omitted `status`, so isActive() defaulted it to active and
// linked the skill regardless of its real lifecycle status. Since new skills
// default to `draft`, this silently linked drafts into every runtime on the
// primary authoring path (create draft -> rename it).
test("migrateOp renaming a draft skill does not link it into consumers", () => {
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
  assert.ok(!existsSync(path.join(rt, "new-draft")));
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

test("restoreOp restoring a draft skill does not link it into consumers", () => {
  const vault = makeTmp();
  const rt = makeTmp();
  makeConfig(vault, { claude: rt });
  const dir = path.join(vault, "cat", "draft-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: draft-skill\ndescription: test skill\nstatus: draft\n---\n\n# draft-skill\n`,
  );
  archiveOp(vault, "draft-skill", "wip", true);
  assert.ok(
    existsSync(path.join(vault, ".archive", "draft-skill", "SKILL.md")),
  );
  const out = restoreOp(vault, "draft-skill", true);
  assert.equal(out.status, 0);
  assert.ok(existsSync(path.join(vault, "draft-skill", "SKILL.md")));
  assert.ok(!existsSync(path.join(rt, "draft-skill")));
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

test("bulkRenameOp add-prefix renames many and rewrites the frontmatter name", () => {
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
  mk("foo");
  mk("bar");
  const dry = bulkRenameOp(
    vault,
    ["foo", "bar"],
    { op: "add-prefix", value: "b19-" },
    false,
  );
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.some((a) => a.includes('"foo" -> "b19-foo"')));
  assert.ok(existsSync(path.join(vault, "foo"))); // dry-run: not renamed

  const wet = bulkRenameOp(
    vault,
    ["foo", "bar"],
    { op: "add-prefix", value: "b19-" },
    true,
  );
  assert.equal(wet.status, 0);
  assert.ok(existsSync(path.join(vault, "b19-foo", "SKILL.md")));
  assert.match(
    readFileSync(path.join(vault, "b19-foo", "SKILL.md"), "utf8"),
    /name: b19-foo/,
  );
});

test("bulkRenameOp refuses a batch that would collide, writing nothing", () => {
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
  mk("test-foo");
  mk("foo");
  // strip-prefix "test-" turns test-foo into foo, which already exists
  const r = bulkRenameOp(
    vault,
    ["test-foo"],
    { op: "strip-prefix", value: "test-" },
    true,
  );
  assert.equal(r.status, 2);
  assert.ok(existsSync(path.join(vault, "test-foo"))); // untouched
});

test("bulkRenameOp replace transform renames matching names and skips non-matching", () => {
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
  mk("foo-old");
  mk("bar"); // no "old" substring -> no-op, skipped (not an error)
  const r = bulkRenameOp(
    vault,
    ["foo-old", "bar"],
    { op: "replace", from: "old", to: "new" },
    true,
  );
  assert.equal(r.status, 0);
  assert.ok(existsSync(path.join(vault, "foo-new", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, "foo-old")));
  assert.match(
    readFileSync(path.join(vault, "foo-new", "SKILL.md"), "utf8"),
    /name: foo-new/,
  );
  assert.ok(existsSync(path.join(vault, "bar"))); // no-op member untouched
});
