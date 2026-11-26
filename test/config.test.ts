import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import {
  expandTilde,
  loadConfig,
  saveConfig,
  resolveConsumers,
  validateLint,
  resolveAxes,
  DEFAULT_IGNORE,
  type LoomConfig,
} from "../src/config.js";
import { UsageError } from "../src/errors.js";

test("expandTilde expands ~ and ~/ but not others", () => {
  assert.equal(expandTilde("~"), homedir());
  assert.equal(expandTilde("~/x/y"), path.join(homedir(), "x/y"));
  assert.equal(expandTilde("/abs/path"), "/abs/path");
});

test("loadConfig throws UsageError when loom.json is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  assert.throws(() => loadConfig(dir), UsageError);
});

test("loadConfig throws UsageError when loom.json is malformed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(path.join(dir, "loom.json"), "{invalid");
  assert.throws(() => loadConfig(dir), UsageError);
});

test("loadConfig fills in defaults when keys are absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.consumers, {});
  assert.deepEqual(loaded.ignore, DEFAULT_IGNORE);
  assert.deepEqual(loaded.names, {});
});

test("saveConfig writes consumers and names sorted by key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  saveConfig(dir, {
    schema: 1,
    consumers: { codex: "~/.codex/skills", agents: "~/.agents/skills" },
    ignore: [...DEFAULT_IGNORE],
    names: { zeta: "Zeta", alfa: "Alfa" },
  });
  const raw = readFileSync(path.join(dir, "loom.json"), "utf8");
  assert.ok(raw.indexOf('"agents"') < raw.indexOf('"codex"'));
  assert.ok(raw.indexOf('"alfa"') < raw.indexOf('"zeta"'));
});

test("loadConfig reads the custom names map", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, names: { forpros: "ForPros" } }),
  );
  assert.deepEqual(loadConfig(dir).names, { forpros: "ForPros" });
});

test("resolveConsumers normalizes string (symlink) and object (in-place) values", () => {
  const cfg: LoomConfig = {
    schema: 1,
    consumers: {
      claude: "~/.claude/skills",
      openclaw: { mode: "in-place", note: "served via extraDirs" },
    },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  const list = resolveConsumers(cfg);
  const claude = list.find((c) => c.name === "claude");
  const openclaw = list.find((c) => c.name === "openclaw");
  assert.deepEqual(
    { mode: claude?.mode, dir: claude?.dir },
    { mode: "symlink", dir: path.join(homedir(), ".claude/skills") },
  );
  assert.deepEqual(
    { mode: openclaw?.mode, dir: openclaw?.dir, note: openclaw?.note },
    { mode: "in-place", dir: null, note: "served via extraDirs" },
  );
});

test("resolveConsumers: an in-place consumer's path is browsable but never a link target", () => {
  const cfg: LoomConfig = {
    schema: 1,
    consumers: {
      claude: "~/.claude/skills",
      openclaw: { mode: "in-place", path: "~/.openclaw/skills" },
    },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  const list = resolveConsumers(cfg);
  const claude = list.find((c) => c.name === "claude");
  const openclaw = list.find((c) => c.name === "openclaw");
  // For a symlink consumer the two coincide: links and natives share one dir.
  assert.deepEqual(
    { dir: claude?.dir, skillsDir: claude?.skillsDir },
    {
      dir: path.join(homedir(), ".claude/skills"),
      skillsDir: path.join(homedir(), ".claude/skills"),
    },
  );
  // In-place: dir stays null so link never writes there, but the runtime's own
  // skills root is still known, so its natives can be browsed.
  assert.deepEqual(
    { dir: openclaw?.dir, skillsDir: openclaw?.skillsDir },
    { dir: null, skillsDir: path.join(homedir(), ".openclaw/skills") },
  );
});

test("resolveConsumers: an in-place consumer without a path has no skills root", () => {
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { openclaw: { mode: "in-place", note: "served via extraDirs" } },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  const openclaw = resolveConsumers(cfg).find((c) => c.name === "openclaw");
  assert.deepEqual(
    { dir: openclaw?.dir, skillsDir: openclaw?.skillsDir },
    { dir: null, skillsDir: null },
  );
});

test("saveConfig/loadConfig preserves an in-place consumer object", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { openclaw: { mode: "in-place", note: "x" } },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  saveConfig(dir, cfg);
  assert.deepEqual(loadConfig(dir).consumers, {
    openclaw: { mode: "in-place", note: "x" },
  });
});

test("saveConfig/loadConfig roundtrip with defaults for missing keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: { claude: "~/.claude/skills" },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  };
  saveConfig(dir, cfg);
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded, cfg);
});

const DEFAULT_TEST_AXES = [{ id: "domain" }, { id: "layer" }];

test("validateLint accepts a well-formed lint block", () => {
  assert.equal(
    validateLint(
      {
        strict: true,
        descriptionMinChars: 250,
        descriptionMaxChars: 400,
        bodyMaxLines: 120,
        forbidBodyPatterns: ["\\bTODO\\b"],
        requireSections: ["Policy"],
        requireTaxonomy: ["domain", "layer"],
        allowedDomains: ["a"],
        allowedLayers: ["b"],
      },
      DEFAULT_TEST_AXES,
    ),
    null,
  );
});

test("validateLint rejects an unknown taxonomy axis", () => {
  assert.match(
    validateLint(
      { requireTaxonomy: ["domain", "colour"] },
      DEFAULT_TEST_AXES,
    ) ?? "",
    /requireTaxonomy/,
  );
});

test("validateLint rejects min greater than max", () => {
  assert.match(
    validateLint(
      { descriptionMinChars: 500, descriptionMaxChars: 400 },
      DEFAULT_TEST_AXES,
    ) ?? "",
    /<=/,
  );
});

test("validateLint rejects an invalid forbidden regex", () => {
  assert.match(
    validateLint({ forbidBodyPatterns: ["[unclosed("] }, DEFAULT_TEST_AXES) ??
      "",
    /invalid regex/,
  );
});

test("validateLint rejects a non-array allowedDomains", () => {
  assert.match(
    validateLint({ allowedDomains: "a" }, DEFAULT_TEST_AXES) ?? "",
    /allowedDomains/,
  );
});

test("loadConfig drops a consumer with an empty path and keeps the valid rest", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "loom-cfg-"));
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({ schema: 1, consumers: { bad: "", good: "/tmp/x" } }),
  );
  const cfg = loadConfig(vault);
  assert.equal(cfg.consumers.bad, undefined);
  assert.equal(cfg.consumers.good, "/tmp/x");
});

test("loadConfig throws on an invalid lint block", () => {
  const vault = mkdtempSync(path.join(tmpdir(), "loom-cfg-"));
  writeFileSync(
    path.join(vault, "loom.json"),
    JSON.stringify({ schema: 1, consumers: {}, lint: "nope" }),
  );
  assert.throws(() => loadConfig(vault), UsageError);
});

test("validateLint rejects a structuredDocs entry with no file", () => {
  assert.ok(
    validateLint({ structuredDocs: [{ h1Prefix: "# X" }] }, DEFAULT_TEST_AXES),
  );
});

test("structuredDocs carries no vocabulary of its own", async () => {
  const { DEFAULT_LINT } = await import("../src/commands/init.js");
  // skill-loom is public: shipping one vault's document names would impose them
  assert.equal(DEFAULT_LINT.structuredDocs, undefined);
  assert.equal(DEFAULT_LINT.absolutePathIgnoreFiles, undefined);
});

test("validateLint rejects a non-string in protectedTerms", () => {
  assert.match(
    validateLint({ protectedTerms: ["ok", 3] }, DEFAULT_TEST_AXES) ?? "",
    /protectedTerms/,
  );
});

test("validateLint rejects a lossAcceptance with an empty reason", () => {
  assert.match(
    validateLint(
      {
        lossAcceptances: [
          { file: "a.md", term: "X", reason: "  ", baseline: "h" },
        ],
      },
      DEFAULT_TEST_AXES,
    ) ?? "",
    /reason/,
  );
});

test("validateLint rejects a lossAcceptance missing baseline", () => {
  assert.match(
    validateLint(
      {
        lossAcceptances: [{ file: "a.md", term: "X", reason: "r" }],
      },
      DEFAULT_TEST_AXES,
    ) ?? "",
    /baseline/,
  );
});

test("validateLint accepts well-formed protectedTerms and lossAcceptances", () => {
  assert.equal(
    validateLint(
      {
        protectedTerms: ["HogQL", "Sender.net"],
        lossAcceptances: [
          {
            file: "a.md",
            term: "X",
            reason: "consolidated elsewhere",
            baseline: "abc",
          },
        ],
      },
      DEFAULT_TEST_AXES,
    ),
    null,
  );
});

test("resolveAxes: declared taxonomy wins, in declaration order", () => {
  const cfg = {
    taxonomy: {
      domain: { label: "Domain", values: ["cross"] },
      area: { values: ["governance-quality"] },
      kind: {},
    },
    lint: { allowedDomains: ["ignored"], allowedLayers: ["ignored"] },
  } as unknown as LoomConfig;
  const axes = resolveAxes(cfg);
  assert.deepEqual(
    axes.map((a) => a.id),
    ["domain", "area", "kind"],
  );
  assert.deepEqual(axes[0].values, ["cross"]);
  assert.equal(axes[0].label, "Domain");
  // legacy keys are ignored, not merged, when taxonomy is declared
  assert.deepEqual(axes[1].values, ["governance-quality"]);
  assert.equal(axes[2].values, undefined);
});

test("resolveAxes: legacy keys synthesise domain+layer", () => {
  const cfg = {
    lint: { allowedDomains: ["cross"], allowedLayers: ["tool"] },
  } as unknown as LoomConfig;
  const axes = resolveAxes(cfg);
  assert.deepEqual(
    axes.map((a) => a.id),
    ["domain", "layer"],
  );
  assert.deepEqual(axes[0].values, ["cross"]);
  assert.deepEqual(axes[1].values, ["tool"]);
});

test("resolveAxes: only one legacy key still yields both axes", () => {
  const cfg = { lint: { allowedDomains: ["cross"] } } as unknown as LoomConfig;
  const axes = resolveAxes(cfg);
  assert.deepEqual(
    axes.map((a) => a.id),
    ["domain", "layer"],
  );
  assert.deepEqual(axes[0].values, ["cross"]);
  assert.equal(axes[1].values, undefined);
});

test("resolveAxes: no config at all falls back to unvalidated domain+layer", () => {
  const axes = resolveAxes({} as unknown as LoomConfig);
  assert.deepEqual(
    axes.map((a) => a.id),
    ["domain", "layer"],
  );
  assert.equal(axes[0].values, undefined);
  assert.equal(axes[1].values, undefined);
});

test("resolveAxes: empty values array means 'do not validate', not 'nothing allowed'", () => {
  const cfg = {
    taxonomy: { domain: { values: [] } },
  } as unknown as LoomConfig;
  assert.equal(resolveAxes(cfg)[0].values, undefined);
});

test("resolveAxes: existing axis ids in the suite all pass validation", () => {
  const cfg = {
    taxonomy: {
      domain: { values: ["cross"] },
      layer: {},
      area: { values: ["governance-quality"] },
      kind: { values: ["framework"] },
    },
  } as unknown as LoomConfig;
  assert.doesNotThrow(() => resolveAxes(cfg));
});

test("resolveAxes: rejects an axis id with a bad shape", () => {
  const cfg = {
    taxonomy: { "a(": { values: ["x"] } },
  } as unknown as LoomConfig;
  assert.throws(
    () => resolveAxes(cfg),
    /taxonomy axis "a\(" is not a valid id/,
  );
});

test("resolveAxes: rejects a reserved axis id", () => {
  for (const id of ["status", "link", "sync", "description", "skill", "hay"]) {
    const cfg = { taxonomy: { [id]: {} } } as unknown as LoomConfig;
    assert.throws(
      () => resolveAxes(cfg),
      new RegExp(`taxonomy axis "${id}" is a reserved name`),
    );
  }
});

test("resolveAxes: rejects a non-array values", () => {
  const cfg = {
    taxonomy: { kind: { values: "framework" } },
  } as unknown as LoomConfig;
  assert.throws(
    () => resolveAxes(cfg),
    /taxonomy axis "kind"\.values must be an array of strings/,
  );
});

test("resolveAxes: rejects a values array with a non-string element", () => {
  const cfg = {
    taxonomy: { kind: { values: ["framework", 5] } },
  } as unknown as LoomConfig;
  assert.throws(
    () => resolveAxes(cfg),
    /taxonomy axis "kind"\.values must be an array of strings/,
  );
});

test("validateLint: requireTaxonomy accepts any declared axis id", () => {
  const axes = [{ id: "domain" }, { id: "area" }, { id: "kind" }];
  assert.equal(
    validateLint({ requireTaxonomy: ["domain", "area", "kind"] }, axes),
    null,
  );
  assert.match(
    String(validateLint({ requireTaxonomy: ["layer"] }, axes)),
    /unknown axis "layer"/,
  );
});

test("saveConfig/loadConfig: taxonomy axis declaration order survives the roundtrip", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  const cfg: LoomConfig = {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    taxonomy: { domain: {}, area: {}, kind: {} },
  };
  saveConfig(dir, cfg);
  const raw = readFileSync(path.join(dir, "loom.json"), "utf8");
  assert.ok(raw.indexOf('"domain"') < raw.indexOf('"area"'));
  assert.ok(raw.indexOf('"area"') < raw.indexOf('"kind"'));
  assert.deepEqual(Object.keys(loadConfig(dir).taxonomy ?? {}), [
    "domain",
    "area",
    "kind",
  ]);
});

test("resolveAxes: pinned hues are validated and carried through", () => {
  const cfg = {
    consumers: {},
    names: {},
    taxonomy: {
      area: {
        values: ["commercial", "content"],
        hues: { commercial: [52], content: [330, 0.05] },
        tile: true,
      },
    },
  } as never;
  const [area] = resolveAxes(cfg);
  assert.deepEqual(area.hues, { commercial: [52], content: [330, 0.05] });
  assert.equal(area.tile, true);
});

test("resolveAxes: a malformed hue pin throws instead of silently unpinning", () => {
  // A typo'd pin that fell back to the rank palette would recolour that one
  // value with no error anywhere — the failure mode pinning exists to prevent.
  const cfg = {
    consumers: {},
    names: {},
    taxonomy: { area: { hues: { commercial: "orange" } } },
  } as never;
  assert.throws(() => resolveAxes(cfg), /hues\["commercial"\] must be/);
});
