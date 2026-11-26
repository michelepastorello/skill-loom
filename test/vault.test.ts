import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanVault,
  validateVault,
  skillWarnings,
  parseFrontmatterName,
  parseFrontmatterField,
  parseFirstH1,
  waiverReason,
  isActive,
  isLinked,
  isProjectedStatus,
  NAME_RE,
} from "../src/vault.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";
import { collectDoctor } from "../src/gate.js";
import { loadConfig, saveConfig, type LoomConfig } from "../src/config.js";

test("parseFrontmatterField reads inline, folded (>) and literal (|) scalars", () => {
  const vault = makeTmp();
  const md = path.join(makeSkill(vault, "c", "s"), "SKILL.md");
  writeFileSync(md, "---\nname: s\ndescription: inline value\n---\n\n# s\n");
  assert.equal(parseFrontmatterField(md, "description"), "inline value");

  writeFileSync(
    md,
    "---\nname: s\ndescription: >-\n  first line\n  second line\n---\n\n# s\n",
  );
  assert.equal(
    parseFrontmatterField(md, "description"),
    "first line second line",
  );

  writeFileSync(
    md,
    "---\nname: s\ndescription: |\n  alpha\n  beta\nother: x\n---\n\n# s\n",
  );
  assert.equal(parseFrontmatterField(md, "description"), "alpha beta");
});

test("parseFrontmatterName reads quoted and plain names", () => {
  const vault = makeTmp();
  const dir = makeSkill(vault, "cat", "my-skill", '"my-skill"');
  assert.equal(parseFrontmatterName(path.join(dir, "SKILL.md")), "my-skill");
});

test("scanVault finds skills at any depth, skips ignore dirs and archive/", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  makeSkill(vault, "business", "alpha");
  makeSkill(vault, "deep/nested", "beta");
  makeSkill(vault, "node_modules", "hidden");
  makeSkill(vault, ".archive", "old-one");
  const names = scanVault(vault, cfg).map((s) => s.name);
  assert.deepEqual(names, ["alpha", "beta"]);
});

test("scanVault reads the lifecycle status, defaulting to active", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  const d1 = path.join(vault, "one");
  mkdirSync(d1, { recursive: true });
  writeFileSync(
    path.join(d1, "SKILL.md"),
    `---\nname: one\ndescription: x\nstatus: draft\n---\n\n# one\n`,
  );
  const d2 = path.join(vault, "two");
  mkdirSync(d2, { recursive: true });
  writeFileSync(
    path.join(d2, "SKILL.md"),
    `---\nname: two\ndescription: x\n---\n\n# two\n`,
  );
  const byName = Object.fromEntries(
    scanVault(vault, cfg).map((s) => [s.name, s]),
  );
  assert.equal(byName.one.status, "draft");
  assert.equal(byName.two.status, "active"); // default
  assert.equal(isActive(byName.two), true);
  assert.equal(isActive(byName.one), false);
});

test("isLinked projects active and draft, but not idea/suspended/deprecated", () => {
  const mk = (status?: string) =>
    ({ name: "s", dir: "", status }) as Parameters<typeof isLinked>[0];
  assert.equal(isLinked(mk("active")), true);
  assert.equal(isLinked(mk("draft")), true); // review ramp: linked-but-advisory
  assert.equal(isLinked(mk(undefined)), true); // absent defaults to active
  assert.equal(isLinked(mk("idea")), false);
  assert.equal(isLinked(mk("suspended")), false);
  assert.equal(isLinked(mk("deprecated")), false);
  // isActive stays strict: only active (draft is advisory to the gate)
  assert.equal(isActive(mk("draft")), false);
});

// The same rule, reachable from a bare status string: an op that is about to
// WRITE a status has no Skill to ask yet, and copying the boundary by hand is
// how it drifted from isLinked in the first place.
test("isProjectedStatus answers the projection rule for a bare status", () => {
  assert.equal(isProjectedStatus("active"), true);
  assert.equal(isProjectedStatus("draft"), true);
  assert.equal(isProjectedStatus(undefined), true); // absent defaults to active
  assert.equal(isProjectedStatus("idea"), false);
  assert.equal(isProjectedStatus("suspended"), false);
  assert.equal(isProjectedStatus("deprecated"), false);
});

test("validateVault flags invalid name, frontmatter mismatch, duplicates", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  makeSkill(vault, "a", "Bad_Name");
  makeSkill(vault, "a", "mismatch", "other-name");
  makeSkill(vault, "b", "twin");
  makeSkill(vault, "c", "twin");
  const kinds = validateVault(scanVault(vault, cfg))
    .map((p) => p.kind)
    .sort();
  assert.deepEqual(kinds, ["duplicate", "invalid-name", "name-mismatch"]);
});

test("parseFirstH1 returns the first heading after the frontmatter", () => {
  const vault = makeTmp();
  const md = path.join(makeSkill(vault, "c", "s"), "SKILL.md");
  writeFileSync(
    md,
    "---\nname: s\ndescription: d\n---\n\n# The Title\n\n# later\n",
  );
  assert.equal(parseFirstH1(md), "The Title");

  // no frontmatter → still finds the H1
  writeFileSync(md, "# Bare Title\n\nbody\n");
  assert.equal(parseFirstH1(md), "Bare Title");

  // no H1 at all
  writeFileSync(md, "---\nname: s\n---\n\njust prose\n");
  assert.equal(parseFirstH1(md), null);
});

test("skillWarnings flags H1≠name and machine-specific absolute paths", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  // H1 differs from name
  const bad = makeSkill(vault, "a", "alpha");
  writeFileSync(
    path.join(bad, "SKILL.md"),
    "---\nname: alpha\ndescription: d\n---\n\n# Alpha Skill\n",
  );
  // absolute machine path in the body (H1 matches, so only the path warns)
  const port = makeSkill(vault, "a", "bravo");
  writeFileSync(
    path.join(port, "SKILL.md"),
    "---\nname: bravo\ndescription: d\n---\n\n# bravo\n\nRun /home/michele/tool.py\n",
  );
  // clean skill → no warnings
  makeSkill(vault, "a", "charlie");

  const w = skillWarnings(scanVault(vault, cfg));
  const byName = (n: string) =>
    w.filter((x) => x.name === n).map((x) => x.kind);
  assert.deepEqual(byName("alpha"), ["h1-mismatch"]);
  assert.deepEqual(byName("bravo"), ["absolute-path"]);
  assert.deepEqual(byName("charlie"), []);
});

test("skillWarnings runs config-driven lint checks when a lint block is set", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "alpha");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: alpha\ndescription: short\nlayer: bogus\n---\n\n# alpha\n\nbody\n",
  );
  const cfg = {
    ...base,
    lint: {
      descriptionMaxChars: 3, // "short" (5) exceeds → description-length
      requireTaxonomy: ["domain"], // domain absent → missing-taxonomy
      requireSections: ["Policy"], // no Policy heading → missing-section
      allowedLayers: ["tool", "engine"], // layer "bogus" → unknown-layer
    },
  };
  const kinds = skillWarnings(scanVault(vault, cfg), cfg)
    .map((w) => w.kind)
    .sort();
  assert.deepEqual(kinds, [
    "description-length",
    "missing-section",
    "missing-taxonomy",
    "unknown-layer",
  ]);
});

test("skillWarnings: declared axes produce unknown-<axis> findings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  mkdirSync(path.join(dir, "alpha"), { recursive: true });
  writeFileSync(
    path.join(dir, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: a description long enough\ndomain: cross\narea: bogus\nkind: framework\n---\n\n# alpha\n\nbody\n",
  );
  const cfg = {
    ignore: [],
    taxonomy: {
      domain: { values: ["cross"] },
      area: { values: ["governance-quality"] },
      kind: { values: ["framework"] },
    },
  } as unknown as LoomConfig;
  const kinds = skillWarnings(scanVault(dir, cfg), cfg).map((w) => w.kind);
  assert.ok(kinds.includes("unknown-area"));
  assert.ok(!kinds.includes("unknown-domain"));
  assert.ok(!kinds.includes("unknown-kind"));
});

test("skillWarnings: legacy config still emits unknown-layer (regression)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  mkdirSync(path.join(dir, "alpha"), { recursive: true });
  writeFileSync(
    path.join(dir, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: a description long enough\ndomain: bogus\nlayer: bogus\n---\n\n# alpha\n\nbody\n",
  );
  const cfg = {
    ignore: [],
    lint: {
      allowedDomains: ["cross", "product"],
      allowedLayers: ["tool", "engine"],
    },
  } as unknown as LoomConfig;
  const kinds = skillWarnings(scanVault(dir, cfg), cfg).map((w) => w.kind);
  assert.ok(kinds.includes("unknown-domain"));
  assert.ok(kinds.includes("unknown-layer"));
});

test("skillWarnings with no lint block only runs the built-in hygiene checks", () => {
  const vault = makeTmp();
  const cfg = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "alpha");
  // clean H1/path but a tiny description and no taxonomy: silent without lint
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: alpha\ndescription: x\n---\n\n# alpha\n",
  );
  assert.deepEqual(skillWarnings(scanVault(vault, cfg), cfg), []);
});

test("NAME_RE accepts kebab, rejects uppercase/underscore/leading-dash", () => {
  assert.ok(NAME_RE.test("skill-loom"));
  assert.ok(!NAME_RE.test("Skill"));
  assert.ok(!NAME_RE.test("a_b"));
  assert.ok(!NAME_RE.test("-x"));
});

test("skillWarnings flags a description under descriptionMinChars", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: too short\n---\n\n# s\n",
  );
  const cfg = { ...base, lint: { descriptionMinChars: 250 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "description-length" && x.detail.includes("< 250"),
    ),
  );
});

test("skillWarnings flags an empty or absent description under descriptionMinChars", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const empty = makeSkill(vault, "a", "empty");
  writeFileSync(
    path.join(empty, "SKILL.md"),
    "---\nname: empty\ndescription:\n---\n\n# empty\n",
  );
  const absent = makeSkill(vault, "a", "absent");
  writeFileSync(
    path.join(absent, "SKILL.md"),
    "---\nname: absent\nlayer: tool\n---\n\n# absent\n",
  );
  const cfg = { ...base, lint: { descriptionMinChars: 250 } };
  const flagged = new Set(
    skillWarnings(scanVault(vault, cfg), cfg)
      .filter((x) => x.kind === "description-length")
      .map((x) => x.name),
  );
  assert.ok(flagged.has("empty"), "empty description must be flagged");
  assert.ok(flagged.has("absent"), "absent description must be flagged");
});

test("forbidBodyPatterns flags a forbidden regex in the body", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\n---\n\n# s\n\nssh into 10.0.0.1 now\n",
  );
  const cfg = {
    ...base,
    lint: { forbidBodyPatterns: ["\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"] },
  };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "forbidden-pattern" && x.detail.includes("10.0.0.1"),
    ),
  );
});

test("an invalid forbidBodyPatterns regex is surfaced, not thrown", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  makeSkill(vault, "a", "s");
  const cfg = { ...base, lint: { forbidBodyPatterns: ["(unclosed"] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some(
      (x) => x.kind === "forbidden-pattern" && x.detail.includes("invalid"),
    ),
  );
});

test("bodyMaxLines fires without a waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const longBody = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\n---\n\n# s\n" + longBody + "\n",
  );
  const cfg = { ...base, lint: { bodyMaxLines: 3 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(w.some((x) => x.kind === "body-length"));
});

test("bodyMaxLines is suppressed by a length-waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const longBody = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  const fm =
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    length-waiver:\n      reason: runbook non separabile\n---\n\n# s\n" +
    longBody +
    "\n";
  writeFileSync(path.join(d, "SKILL.md"), fm);
  const cfg = { ...base, lint: { bodyMaxLines: 3 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "body-length"));
});

test("waiverReason reads the nested reason for a given key, else null", () => {
  const vault = makeTmp();
  const d = makeSkill(vault, "a", "s");
  const md = path.join(d, "SKILL.md");
  writeFileSync(md, "---\nname: s\ndescription: d\n---\n\n# s\n");
  assert.equal(waiverReason(md, "length-waiver"), null);
  writeFileSync(
    md,
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    length-waiver:\n      reason: perché sì\n---\n\n# s\n",
  );
  assert.equal(waiverReason(md, "length-waiver"), "perché sì");
  // key-specific: a forbid-waiver is not read as a length-waiver
  assert.equal(waiverReason(md, "forbid-waiver"), null);
});

test("waiverReason does not leak a sibling waiver's reason into a reasonless key (#20)", () => {
  const vault = makeTmp();
  const d = makeSkill(vault, "a", "leak");
  const md = path.join(d, "SKILL.md");
  writeFileSync(
    md,
    "---\nname: leak\ndescription: d\nmetadata:\n  lint:\n    length-waiver:\n      approved: true\n    forbid-waiver:\n      reason: allowed here\n---\n\n# leak\n",
  );
  // length-waiver's own block has no reason — must not borrow forbid-waiver's.
  assert.equal(waiverReason(md, "length-waiver"), null);
  assert.equal(waiverReason(md, "forbid-waiver"), "allowed here");
});

test("forbidBodyPatterns is suppressed by a forbid-waiver", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\nmetadata:\n  lint:\n    forbid-waiver:\n      reason: topologia interna Argo\n---\n\n# s\n\nssh 10.0.0.1\n",
  );
  const cfg = {
    ...base,
    lint: { forbidBodyPatterns: ["\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b"] },
  };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "forbidden-pattern"));
});

test("skillWarnings treats an empty allowlist as no restriction, not flag-all", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: s\ndescription: d\ndomain: bottega19\nlayer: tool\n---\n\n# s\n",
  );
  const cfg = {
    ...base,
    lint: { allowedDomains: [], allowedLayers: [] },
  };
  const kinds = skillWarnings(scanVault(vault, cfg), cfg).map((w) => w.kind);
  assert.ok(!kinds.includes("unknown-domain"));
  assert.ok(!kinds.includes("unknown-layer"));
});

test("absolute-path is found in a reference, not only in SKILL.md", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  mkdirSync(path.join(d, "references"), { recursive: true });
  writeFileSync(
    path.join(d, "references", "guide.md"),
    "# Guide\n\nRun /home/someone/tool.py to sync.\n",
  );
  // no lint configured: absolute-path is always-on and must stay that way
  const w = skillWarnings(scanVault(vault, base), base);
  const hit = w.find((x) => x.kind === "absolute-path");
  // the finding must say WHICH file, or nobody can act on it
  assert.equal(hit?.file, "references/guide.md");
});

test("a skill-level check does not fire on a reference", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  mkdirSync(path.join(d, "references"), { recursive: true });
  // no frontmatter, no canonical H1: normal for a reference, and it must not
  // be judged as if it were the skill's own front page
  writeFileSync(
    path.join(d, "references", "notes.md"),
    "# Whatever\n\nprose\n",
  );
  const w = skillWarnings(scanVault(vault, base), base);
  assert.ok(!w.some((x) => x.kind === "h1-mismatch"));
});

test("absolutePathIgnoreFiles skips a file whose whole job is holding paths", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  // a live-state map is a table of where the data lives: paths are its content
  writeFileSync(
    path.join(d, "live-state.md"),
    "# x\n\n| /home/someone/db.sqlite |\n",
  );
  mkdirSync(path.join(d, "references"), { recursive: true });
  writeFileSync(
    path.join(d, "references", "guide.md"),
    "# Guide\n\n/home/someone/tool.py\n",
  );
  const cfg = { ...base, lint: { absolutePathIgnoreFiles: ["live-state.md"] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  const hits = w.filter((x) => x.kind === "absolute-path");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "references/guide.md");
});

test("prose-wall flags a long unbroken paragraph", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const wall = Array.from({ length: 90 }, () => "word").join(" ") + ".";
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: d\n---\n\n# s\n\n**Label.** ${wall}\n`,
  );
  const cfg = { ...base, lint: { proseMaxWords: 75 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(w.some((x) => x.kind === "prose-wall"));
});

test("prose-wall does not flag structure — bullets and tables are not a wall", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const bullets = Array.from(
    { length: 40 },
    (_, i) => `- **X${i}** short why.`,
  ).join("\n");
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: d\n---\n\n# s\n\n${bullets}\n\n| a | b |\n| - | - |\n`,
  );
  const cfg = { ...base, lint: { proseMaxWords: 75 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "prose-wall"));
});

test("prose-wall ignores the frontmatter — a long description is not a wall", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const longDesc = Array.from({ length: 90 }, () => "word").join(" ");
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: ${longDesc}\n---\n\n# s\n\nshort body.\n`,
  );
  const cfg = { ...base, lint: { proseMaxWords: 75 } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "prose-wall"));
});

test("prose-wall is off when the vault sets no threshold", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  const wall = Array.from({ length: 200 }, () => "word").join(" ") + ".";
  writeFileSync(
    path.join(d, "SKILL.md"),
    `---\nname: s\ndescription: d\n---\n\n# s\n\n${wall}\n`,
  );
  // no proseMaxWords: the engine must not invent a house style
  const w = skillWarnings(scanVault(vault, base), base);
  assert.ok(!w.some((x) => x.kind === "prose-wall"));
});

const STRUCTURED = {
  file: "live-state.md",
  h1Prefix: "# Live-state — ",
  requireTable: true,
};

test("structured-doc flags a legacy H1", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "live-state.md"),
    "# Live-data map — foo\n\n| C | D |\n| - | - |\n| a | b |\n",
  );
  const cfg = { ...base, lint: { structuredDocs: [STRUCTURED] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(w.some((x) => x.kind === "structured-doc" && /H1/.test(x.detail)));
});

test("structured-doc flags a missing table", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "live-state.md"),
    "# Live-state — foo\n\njust prose.\n",
  );
  const cfg = { ...base, lint: { structuredDocs: [STRUCTURED] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(
    w.some((x) => x.kind === "structured-doc" && /table/.test(x.detail)),
  );
});

test("structured-doc passes a well-formed doc", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  const d = makeSkill(vault, "a", "s");
  writeFileSync(
    path.join(d, "live-state.md"),
    "# Live-state — foo\n\n| C | D |\n| - | - |\n| a | b |\n",
  );
  const cfg = { ...base, lint: { structuredDocs: [STRUCTURED] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  assert.ok(!w.some((x) => x.kind === "structured-doc"));
});

test("structured-doc says nothing about a skill that has no such doc", () => {
  const vault = makeTmp();
  const base = makeConfig(vault, {});
  makeSkill(vault, "a", "s");
  const cfg = { ...base, lint: { structuredDocs: [STRUCTURED] } };
  const w = skillWarnings(scanVault(vault, cfg), cfg);
  // the doc is optional: declaring its shape must not make it mandatory
  assert.ok(!w.some((x) => x.kind === "structured-doc"));
});

test("a broken structured doc BLOCKS on an active skill and only warns on a draft", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  // the whole point of accepting the draft downgrade: quality is enforced at
  // promotion. If this ever goes green, the ratchet has become an amnesty.
  for (const [name, status] of [
    ["act", "active"],
    ["drf", "draft"],
  ]) {
    const d = makeSkill(vault, "a", name);
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: d\nstatus: ${status}\n---\n\n# ${name}\n`,
    );
    writeFileSync(path.join(d, "live-state.md"), "# Wrong — x\n\nno table.\n");
  }
  const cfg = loadConfig(vault);
  saveConfig(vault, {
    ...cfg,
    lint: { strict: true, structuredDocs: [STRUCTURED] },
  });
  const r = collectDoctor(vault);
  // Match the quoted name: a bare "act" also lives inside the word "active",
  // so a future finding that renders a status word would satisfy this by
  // accident — and a ratchet that passes by accident is not a ratchet.
  assert.ok(
    r.blocking.some((l) => l.includes('"act"')),
    "an active skill's broken live-state must block",
  );
  assert.ok(
    !r.blocking.some((l) => l.includes('"drf"')),
    "a draft's must not block — it is work in progress",
  );
  assert.ok(
    r.warnings.some((l) => l.includes('"drf"')),
    "but the draft must still be told about it, not silently forgiven",
  );
});
