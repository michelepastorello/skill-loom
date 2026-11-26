import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, opt, collectAxisFlags } from "../src/main.js";
import { runInit } from "../src/commands/init.js";
import { runSync } from "../src/commands/sync.js";
import { runLossAudit } from "../src/commands/loss-audit.js";
import { runLossAccept } from "../src/commands/loss-accept.js";
import { UsageError } from "../src/errors.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

test("main: no command prints usage and exits 2", () => {
  assert.equal(main([], makeTmp()), 2);
});

test("main: help exits 0, unknown command exits 2", () => {
  assert.equal(main(["help"], makeTmp()), 0);
  assert.equal(main(["frobnicate"], makeTmp()), 2);
});

test("main: command without config exits 2 (UsageError)", () => {
  assert.equal(main(["link"], makeTmp()), 2);
});

test("main: ui with non-numeric --port exits 2 without starting a server", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  assert.equal(main(["ui", "--port", "abc"], vault), 2);
});

test("table pads columns", async () => {
  const { table } = await import("../src/output.js");
  assert.equal(
    table([
      ["a", "bb"],
      ["ccc", "d"],
    ]),
    "a    bb\nccc  d",
  );
});

test("init creates loom.json and archive/, second run exits 2", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const vault = makeTmp();
  assert.equal(runInit(vault), 0);
  assert.ok(existsSync(path.join(vault, "loom.json")));
  assert.ok(existsSync(path.join(vault, ".archive")));
  assert.equal(runInit(vault), 2);
});

test("init writes a .gitignore covering secrets, build artifacts and OS noise", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const vault = makeTmp();
  runInit(vault);
  const gi = readFileSync(path.join(vault, ".gitignore"), "utf8");
  // A vault is committed and `sync --apply` runs `git add -A`, so secrets that
  // land in a tool-skill (a .env, a *.sqlite, a credentials/ dir) would be
  // pushed unless ignored by default.
  for (const pat of [
    ".env",
    "credentials/",
    "*.sqlite",
    "node_modules/",
    ".venv/",
    ".DS_Store",
  ]) {
    assert.ok(gi.includes(pat), `expected .gitignore to contain ${pat}`);
  }
});

test("init adds secret patterns to a pre-existing .gitignore", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const vault = makeTmp();
  writeFileSync(path.join(vault, ".gitignore"), "dist/\n");
  runInit(vault);
  const gi = readFileSync(path.join(vault, ".gitignore"), "utf8");
  assert.ok(gi.includes("dist/"), "keeps existing entries");
  for (const pat of [".env", "credentials/", "*.sqlite"]) {
    assert.ok(gi.includes(pat), `expected secret pattern ${pat}`);
  }
});

test("ui refuses a non-local --host without --allow-remote-writes", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  assert.equal(main(["ui", "--host", "0.0.0.0"], vault), 2);
});

test("init scaffolds a CONVENTIONS.md starter", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const vault = makeTmp();
  runInit(vault);
  const conv = readFileSync(path.join(vault, "CONVENTIONS.md"), "utf8");
  assert.match(conv, /^# /m); // has a heading
  assert.match(conv, /loom\.json/); // ties to the lint block
});

test("init scaffolds a source-registry.yaml starter", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const vault = makeTmp();
  runInit(vault);
  const reg = readFileSync(path.join(vault, "source-registry.yaml"), "utf8");
  assert.match(reg, /^roots:/m);
  assert.match(reg, /^sources:/m);
});

test("init commits the scaffold so a fresh vault opens clean", async () => {
  const { runInit } = await import("../src/commands/init.js");
  // git needs an identity for the commit; make the test independent of the
  // machine's global config.
  const idKeys = [
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
  ];
  const saved = Object.fromEntries(idKeys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@local",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@local",
  });
  try {
    const vault = makeTmp();
    assert.equal(runInit(vault), 0);
    const log = spawnSync("git", ["-C", vault, "log", "--oneline"], {
      encoding: "utf8",
    });
    assert.equal(log.status, 0);
    assert.equal(log.stdout.trim().split("\n").filter(Boolean).length, 1);
    const porcelain = spawnSync("git", ["-C", vault, "status", "--porcelain"], {
      encoding: "utf8",
    });
    assert.equal(porcelain.stdout.trim(), ""); // nothing left as "unsaved"
  } finally {
    for (const k of idKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("doctor: a consistency warning does not fail the exit code", async () => {
  const { runDoctor } = await import("../src/commands/doctor.js");
  const vault = makeTmp();
  makeConfig(vault, {});
  const dir = makeSkill(vault, "cat", "alpha");
  writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: alpha\ndescription: x\n---\n\n# Not Alpha\n",
  );
  assert.equal(runDoctor(vault), 0);
});

test("doctor: lint strict promotes hygiene findings to exit-code failures", async () => {
  const { runDoctor } = await import("../src/commands/doctor.js");
  const { loadConfig, saveConfig } = await import("../src/config.js");
  const vault = makeTmp();
  makeConfig(vault, {});
  const cfg = loadConfig(vault);
  makeSkill(vault, "cat", "alpha"); // clean, but has no domain

  // lenient: a required-taxonomy gap is a warning → exit 0
  saveConfig(vault, { ...cfg, lint: { requireTaxonomy: ["domain"] } });
  assert.equal(runDoctor(vault), 0);

  // strict: the same gap fails the exit code → exit 1
  saveConfig(vault, {
    ...cfg,
    lint: { strict: true, requireTaxonomy: ["domain"] },
  });
  assert.equal(runDoctor(vault), 1);
});

test("add scaffolds SKILL.md, rejects invalid and duplicate names", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const { runAdd } = await import("../src/commands/add.js");
  const vault = makeTmp();
  runInit(vault);
  assert.equal(runAdd(vault, "my-skill", {}), 0);
  const md = readFileSync(path.join(vault, "my-skill", "SKILL.md"), "utf8");
  assert.match(md, /^name: my-skill$/m);
  assert.equal(runAdd(vault, "My_Skill", {}), 2);
  assert.equal(runAdd(vault, "my-skill", {}), 2);
});

function vaultWithConsumer() {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  makeConfig(vault, { claude: consumerDir });
  return { vault, consumerDir };
}

test("link: dry-run creates nothing, --apply links, conflict exits 1", async () => {
  const { runLink } = await import("../src/commands/link.js");
  const { vault, consumerDir } = vaultWithConsumer();
  makeSkill(vault, "cat", "alpha");
  assert.equal(runLink(vault, false), 0);
  assert.ok(!existsSync(path.join(consumerDir, "alpha")));
  assert.equal(runLink(vault, true), 0);
  assert.ok(lstatSync(path.join(consumerDir, "alpha")).isSymbolicLink());
  makeSkill(vault, "cat", "bravo");
  mkdirSync2(path.join(consumerDir, "bravo"), { recursive: true });
  assert.equal(runLink(vault, true), 1); // conflict
});

test("link: vault validation problems exit 1 before any planning", async () => {
  const { runLink } = await import("../src/commands/link.js");
  const { vault } = vaultWithConsumer();
  makeSkill(vault, "cat", "wrong", "other-name");
  assert.equal(runLink(vault, true), 1);
});

test("doctor: healthy vault exits 0, orphan link exits 1", async () => {
  const { runDoctor } = await import("../src/commands/doctor.js");
  const { runLink } = await import("../src/commands/link.js");
  const { vault, consumerDir } = vaultWithConsumer();
  makeSkill(vault, "cat", "alpha");
  runLink(vault, true);
  assert.equal(runDoctor(vault), 0);
  rmSync(path.join(vault, "cat", "alpha"), { recursive: true }); // skill removed → link now orphan+broken
  assert.equal(runDoctor(vault), 1);
});

test("status exits 0 and prints a row per skill", async () => {
  const { runStatus } = await import("../src/commands/status.js");
  const { vault } = vaultWithConsumer();
  makeSkill(vault, "cat", "alpha");
  assert.equal(runStatus(vault), 0);
});

test("archive: dry-run touches nothing; --apply moves the skill to .archive and unlinks", async () => {
  const { runArchive } = await import("../src/commands/archive.js");
  const { runLink } = await import("../src/commands/link.js");
  const { vault, consumerDir } = vaultWithConsumer();
  makeSkill(vault, "cat", "alpha");
  runLink(vault, true);
  assert.equal(runArchive(vault, "alpha", false), 0);
  assert.ok(existsSync(path.join(vault, "cat", "alpha"))); // dry-run: untouched
  assert.equal(runArchive(vault, "alpha", true), 0);
  assert.ok(existsSync(path.join(vault, ".archive", "alpha", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, "cat", "alpha")));
  assert.ok(
    !lstatSync(path.join(consumerDir, "alpha"), { throwIfNoEntry: false }),
  );
  assert.equal(runArchive(vault, "alpha", true), 2); // not found anymore
});

test("migrate: renames folder, rewrites frontmatter, re-links", async () => {
  const { runMigrate } = await import("../src/commands/migrate.js");
  const { runLink } = await import("../src/commands/link.js");
  const { vault, consumerDir } = vaultWithConsumer();
  makeSkill(vault, "cat", "old-name");
  runLink(vault, true);
  assert.equal(runMigrate(vault, "old-name", "new-name", false), 0);
  assert.ok(existsSync(path.join(vault, "cat", "old-name"))); // dry-run
  assert.equal(runMigrate(vault, "old-name", "new-name", true), 0);
  const md = readFileSync(
    path.join(vault, "cat", "new-name", "SKILL.md"),
    "utf8",
  );
  assert.match(md, /^name: new-name$/m);
  assert.ok(lstatSync(path.join(consumerDir, "new-name")).isSymbolicLink());
  assert.ok(
    !lstatSync(path.join(consumerDir, "old-name"), { throwIfNoEntry: false }),
  );
  assert.equal(runMigrate(vault, "ghost", "x-name", true), 2);
  assert.equal(runMigrate(vault, "new-name", "Bad_Name", true), 2);
});

test("migrate: refuses when target directory already exists", async () => {
  const { runMigrate } = await import("../src/commands/migrate.js");
  const { vault } = vaultWithConsumer();
  makeSkill(vault, "cat", "mover");
  mkdirSync2(path.join(vault, "cat", "taken"), { recursive: true });
  assert.equal(runMigrate(vault, "mover", "taken", true), 2);
  assert.ok(existsSync(path.join(vault, "cat", "mover")));
});

test("opt does not swallow a following flag as its value (#31)", () => {
  const args = ["--domain", "--status", "active"];
  assert.equal(opt(args, "--domain"), undefined); // no value given
  assert.deepEqual(args, ["--status", "active"]); // --status survives
  assert.equal(opt(args, "--status"), "active"); // and parses correctly
});

test("opt returns undefined for a trailing flag with no value (#31)", () => {
  const args = ["--domain"];
  assert.equal(opt(args, "--domain"), undefined);
  assert.deepEqual(args, []);
});

test("opt still returns a normal value and consumes both tokens (#31)", () => {
  const args = ["--domain", "biz", "rest"];
  assert.equal(opt(args, "--domain"), "biz");
  assert.deepEqual(args, ["rest"]);
});

test("collectAxisFlags drains remaining --key value pairs", () => {
  const args = ["--area", "governance-quality", "--kind", "framework", "alpha"];
  assert.deepEqual(collectAxisFlags(args), {
    area: "governance-quality",
    kind: "framework",
  });
  assert.deepEqual(args, ["alpha"]);
});

test("add --layer still works on a legacy vault (regression)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      consumers: {},
      lint: { allowedDomains: ["cross"], allowedLayers: ["tool"] },
    }),
  );
  assert.equal(
    main(["add", "alpha", "--domain", "cross", "--layer", "tool"], dir),
    0,
  );
  const md = readFileSync(path.join(dir, "alpha", "SKILL.md"), "utf8");
  assert.match(md, /domain: cross\nlayer: tool/);
});

test("add --domain creates the skill on a vault that requires domain (regression, #4-fix-1)", () => {
  // Before the fix: main's `add` case built {domain, layer} but AddOptions
  // (Task 3) only reads `.taxonomy`, so the flag was silently dropped —
  // opts.taxonomy was always {}. On a vault with no requireTaxonomy that
  // just meant the value never landed; on a vault that REQUIRES domain, it
  // meant addOp's `missing.length` check failed and NOTHING was created —
  // exit 2, not the "value ignored" symptom the earlier regression test
  // covers. This is the test that would have caught that failure mode.
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      consumers: {},
      lint: { requireTaxonomy: ["domain"], allowedDomains: ["cross"] },
    }),
  );
  assert.equal(main(["add", "alpha", "--domain", "cross"], dir), 0);
  const md = readFileSync(path.join(dir, "alpha", "SKILL.md"), "utf8");
  assert.match(md, /domain: cross/);
});

test("schema: emits axes additively and keeps contract 1", async () => {
  const { runSchema } = await import("../src/commands/schema.js");
  const dir = mkdtempSync(path.join(tmpdir(), "loom-test-"));
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      consumers: {},
      taxonomy: {
        domain: { label: "Domain", values: ["cross"] },
        area: { values: ["governance-quality"] },
      },
    }),
  );
  const out = captureStdout(() => runSchema(dir));
  const j = JSON.parse(out);
  assert.equal(j.contract, 1);
  // derived BY ID, never by position: no layer axis here, so layers is null
  assert.deepEqual(j.taxonomy.domains, ["cross"]);
  assert.equal(j.taxonomy.layers, null);
  assert.deepEqual(j.taxonomy.axes, [
    { id: "domain", label: "Domain", values: ["cross"] },
    { id: "area", values: ["governance-quality"] },
  ]);
});

test("runInit leaves no loom.json when a scaffold step fails, so it can be retried (#36)", () => {
  const vault = makeTmp();
  // Obstacle: .archive already exists as a file, so mkdirSync(.archive) throws
  // mid-init. The re-entry guard (loom.json) must not be left behind.
  writeFileSync(path.join(vault, ".archive"), "x");
  assert.throws(() => runInit(vault));
  assert.ok(!existsSync(path.join(vault, "loom.json")));
});

test("runInit reroots the vault as its own repo when nested in a larger one (#29)", () => {
  const parent = makeTmp();
  spawnSync("git", ["-C", parent, "init", "-q", "-b", "main"], {
    encoding: "utf8",
  });
  const vault = path.join(parent, "vault");
  mkdirSync2(vault, { recursive: true });
  assert.equal(runInit(vault), 0);
  // the vault gets its own .git rather than inheriting the parent repo
  assert.ok(existsSync(path.join(vault, ".git")), "vault is its own repo root");
});

test("runSync propagates syncOp's exit status (#32)", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  // not a git repo → syncOp returns 2; the CLI wrapper must pass it through
  assert.equal(runSync(vault, false), 2);
});

// stdout capture: schema is the first command whose OUTPUT is the deliverable.
function capture(fn: () => number): { code: number; stdout: string } {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void chunks.push(a.join(" "));
  try {
    const code = fn();
    return { code, stdout: chunks.join("\n") };
  } finally {
    console.log = orig;
  }
}

test("schema emits the lifecycle and the vault's taxonomy as one contract", async () => {
  const { loadConfig, saveConfig } = await import("../src/config.js");
  const vault = makeTmp();
  makeConfig(vault, {});
  saveConfig(vault, {
    ...loadConfig(vault),
    lint: { allowedDomains: ["ops"], allowedLayers: ["tool"] },
  });

  const out = capture(() => main(["schema"], vault));
  assert.equal(out.code, 0);
  const doc = JSON.parse(out.stdout);

  assert.equal(doc.contract, 1);
  // the lifecycle is skill-loom's: it decides what gets projected
  assert.deepEqual(doc.lifecycle.statuses, [
    "idea",
    "draft",
    "active",
    "suspended",
    "deprecated",
  ]);
  assert.deepEqual(doc.lifecycle.projected, ["draft", "active"]);
  // the vocabulary is the vault's: read back, never invented
  assert.deepEqual(doc.taxonomy.domains, ["ops"]);
  assert.deepEqual(doc.taxonomy.layers, ["tool"]);
});

test("schema reports an undeclared allowlist as null, not as an empty list", () => {
  const vault = makeTmp();
  makeConfig(vault, {}); // no lint block at all
  const doc = JSON.parse(capture(() => main(["schema"], vault)).stdout);
  // [] would read as "nothing is allowed" and fail every skill in the vault
  assert.equal(doc.taxonomy.domains, null);
  assert.equal(doc.taxonomy.layers, null);
});

test("schema reports an explicit empty allowlist as null too, not as []", async () => {
  // skill-loom's own doctor treats an empty allowlist the same as an absent
  // one ("no restriction" — see vault.ts's `lint.allowedDomains?.length`
  // gate). [] and absent mean the same thing to skill-loom, so the contract
  // must not distinguish them: if it did, it would tell the gate the exact
  // opposite of what skill-loom itself does with the same config.
  const { loadConfig, saveConfig } = await import("../src/config.js");
  const vault = makeTmp();
  makeConfig(vault, {});
  saveConfig(vault, {
    ...loadConfig(vault),
    lint: { allowedDomains: [], allowedLayers: [] },
  });

  const doc = JSON.parse(capture(() => main(["schema"], vault)).stdout);
  assert.equal(doc.taxonomy.domains, null);
  assert.equal(doc.taxonomy.layers, null);
});

test("schema rejects a stray argument instead of silently accepting it", () => {
  // schema is read-only, so an unknown trailing arg (e.g. a typo'd --apply)
  // does nothing harmful — but silently accepting it implies it did
  // something. It should be rejected rather than ignored.
  const vault = makeTmp();
  makeConfig(vault, {});
  const out = capture(() => main(["schema", "--apply"], vault));
  assert.equal(out.code, 2);
  assert.equal(out.stdout, ""); // no contract printed on a rejected call
});

test("init ships a lint baseline a new vault can start from", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const { loadConfig } = await import("../src/config.js");
  const vault = makeTmp();
  runInit(vault);
  const lint = loadConfig(vault).lint;

  // a fresh vault gets quality floors, not a blank page to invent from
  assert.ok(lint, "init must scaffold a lint block");
  assert.ok((lint?.descriptionMinChars ?? 0) > 0);
  assert.ok((lint?.bodyMaxLines ?? 0) > 0);
  // ...advisory on day one: a new vault must not open already failing
  assert.equal(lint?.strict, false);
});

test("init's lint baseline carries no vocabulary of its own", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const { loadConfig } = await import("../src/config.js");
  const vault = makeTmp();
  runInit(vault);
  const lint = loadConfig(vault).lint;

  // skill-loom is a public tool: shipping one person's taxonomy would impose
  // it on every vault. The shape is ours, the words are the owner's.
  assert.equal(lint?.allowedDomains, undefined);
  assert.equal(lint?.allowedLayers, undefined);
  assert.equal(lint?.requireSections, undefined);
  assert.equal(lint?.requireTaxonomy, undefined);
});

test("DEFAULT_LINT passes validateLint", async () => {
  // DEFAULT_LINT (init.ts) is a hand-written literal that nothing exercises
  // through validateLint (config.ts). It's well-formed today, but nothing
  // pins it staying that way if it's ever edited — this test is that pin.
  const { DEFAULT_LINT } = await import("../src/commands/init.js");
  const { validateLint } = await import("../src/config.js");
  assert.equal(
    validateLint(DEFAULT_LINT, [{ id: "domain" }, { id: "layer" }]),
    null,
  );
});

// loss-audit — no existing test sets up a real git repo, so this helper is
// the mechanism: it inits a throwaway repo per test in a tmp dir.
function gitInit(dir: string) {
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  return g;
}

test("loss-audit flags a lost protected term and exits 1", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  writeFileSync(path.join(dir, "s.md"), "Query with `HogQL` and cost €500.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "s.md"), "Query rewritten, cost gone.\n"); // lost HogQL and €500
  const code = runLossAudit(dir, ["--base", "HEAD", "s.md"]);
  assert.equal(code, 1);
});

test("loss-audit passes when a lost term is accepted with a fresh baseline", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const oldText = execFileSync("git", ["-C", dir, "show", "HEAD:s.md"], {
    encoding: "utf8",
  });
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  // record the acceptance the way Task 5's `accept` verb will:
  const { baselineFingerprint } = await import("../src/loss.js");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      schema: 1,
      lint: {
        protectedTerms: ["HogQL"],
        lossAcceptances: [
          {
            file: "s.md",
            term: "HogQL",
            reason: "moved to X",
            baseline: baselineFingerprint(oldText),
          },
        ],
      },
    }),
  );
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 0);
});

test("loss-audit fails on a NEW loss even when another term is accepted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL` and `PostHog`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  const oldText = execFileSync("git", ["-C", dir, "show", "HEAD:s.md"], {
    encoding: "utf8",
  });
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n"); // PostHog is the NEW, unaccepted loss
  const { baselineFingerprint } = await import("../src/loss.js");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      schema: 1,
      lint: {
        protectedTerms: ["HogQL", "PostHog"],
        // The acceptance covers a DIFFERENT term (HogQL, still present); it must
        // NOT silence the genuinely new PostHog loss.
        lossAcceptances: [
          {
            file: "s.md",
            term: "HogQL",
            reason: "unrelated",
            baseline: baselineFingerprint(oldText),
          },
        ],
      },
    }),
  );
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 1);
});

test("loss-audit re-fails a loss whose acceptance went stale (baseline changed)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `PostHog`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n"); // PostHog lost
  const { baselineFingerprint } = await import("../src/loss.js");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      schema: 1,
      lint: {
        protectedTerms: ["PostHog"],
        // Acceptance exists for PostHog but was reviewed against a DIFFERENT
        // baseline → stale → the loss must resurface (code 1, flagged "stale").
        lossAcceptances: [
          {
            file: "s.md",
            term: "PostHog",
            reason: "reviewed against an older baseline",
            baseline: baselineFingerprint("a different baseline text"),
          },
        ],
      },
    }),
  );
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 1);
});

test("loss-audit honors --map for a renamed file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "old.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "new.md"), "Uses `HogQL`.\n");
  execFileSync("rm", [path.join(dir, "old.md")]);
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  assert.equal(
    runLossAudit(dir, ["--base", "HEAD", "--map", "old.md=new.md", "old.md"]),
    0,
  );
});

test("loss-audit honors a one-to-many split (--map repeated) across owners", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  // one legacy file carrying two protected terms, split between two owners
  writeFileSync(
    path.join(dir, "legacy.md"),
    "Owner A uses `HogQL`. Owner B uses `PostHog`.\n",
  );
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "a.md"), "Owner A uses `HogQL`.\n");
  writeFileSync(path.join(dir, "b.md"), "Owner B uses `PostHog`.\n");
  execFileSync("rm", [path.join(dir, "legacy.md")]);
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({
      schema: 1,
      lint: { protectedTerms: ["HogQL", "PostHog"] },
    }),
  );
  // both terms are covered, each in a different successor → pass
  assert.equal(
    runLossAudit(dir, [
      "--base",
      "HEAD",
      "--map",
      "legacy.md=a.md",
      "--map",
      "legacy.md=b.md",
      "legacy.md",
    ]),
    0,
  );
});

test("loss-audit rejects a malformed --map with a UsageError, not a stack trace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  gitInit(dir);
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () => runLossAudit(dir, ["--map", "bad"]),
    /UsageError|old\.md=new\.md/,
  );
});

test("accept refuses a blank reason", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () => runLossAccept(dir, ["s.md", "--term", "HogQL", "--reason", "   "]),
    /reason/,
  );
});

test("accept writes a content-bound acceptance that silences the loss", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  assert.equal(
    runLossAccept(dir, [
      "s.md",
      "--term",
      "HogQL",
      "--reason",
      "moved to X",
      "--base",
      "HEAD",
      "--dropped",
    ]),
    0,
  );
  // now the audit passes
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 0);
});

test("accept requires exactly one file path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  gitInit(dir);
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () => runLossAccept(dir, ["--term", "X", "--reason", "r"]),
    /file/,
  );
});

test("loss-audit dispatches 'accept' as its first subcommand", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  // going through runLossAudit's "accept" dispatch, not runLossAccept directly
  assert.equal(
    runLossAudit(dir, [
      "accept",
      "s.md",
      "--term",
      "HogQL",
      "--reason",
      "moved to X",
      "--base",
      "HEAD",
      "--dropped",
    ]),
    0,
  );
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 0);
});

test("accept keys on the legacy path so a rename+drop can be silenced via --map", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "old.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  // working tree: renamed AND the protected term genuinely dropped
  writeFileSync(path.join(dir, "new.md"), "Rewritten, no term.\n");
  execFileSync("rm", [path.join(dir, "old.md")]);
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  // accept keys on the LEGACY path ("old.md") — the same path the audit
  // iterates via `git ls-tree base` and hashes via `git show base:file`.
  assert.equal(
    runLossAccept(dir, [
      "old.md",
      "--term",
      "HogQL",
      "--reason",
      "renamed and rewritten, term intentionally dropped",
      "--base",
      "HEAD",
      "--dropped",
    ]),
    0,
  );
  // this MUST fail if auditFile ever keys isAccepted on the mapped/new path
  // ("new.md") instead of the legacy path ("old.md").
  assert.equal(
    runLossAudit(dir, ["--base", "HEAD", "--map", "old.md=new.md", "old.md"]),
    0,
  );
});

test("loss-audit raises UsageError (not a raw stack trace) on a bogus --base", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () => runLossAudit(dir, ["--base", "no-such-rev-xyz", "s.md"]),
    (err: unknown) => {
      assert.ok(err instanceof UsageError, "expected a UsageError");
      // one clean line, no embedded newline/stack trace
      assert.ok(!(err as Error).message.includes("\n"));
      return true;
    },
  );
});

test("accept raises UsageError (not a raw stack trace) on a path absent from the baseline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () =>
      runLossAccept(dir, [
        "does-not-exist.md",
        "--term",
        "HogQL",
        "--reason",
        "x",
        "--dropped",
      ]),
    (err: unknown) => {
      assert.ok(err instanceof UsageError, "expected a UsageError");
      assert.ok(!(err as Error).message.includes("\n"));
      return true;
    },
  );
});

test("main maps a git-triggered UsageError to exit code 2, not a crash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.equal(
    main(["loss-audit", "--base", "no-such-rev-xyz", "s.md"], dir),
    2,
  );
});

// --map-term is a TRANSIENT, per-run, reason-less, global-across-all-files
// rename assertion (mirrors --map for content). It is never written to
// loom.json, so it cannot silence a future run's new loss — only `accept`
// (content-bound, persisted, per-file, requires --reason) can do that. See
// the comment above termIsCovered() for the canonical statement.
test("loss-audit: --map-term covers a genuine rename, and is required to do so", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "loss-"));
  const g = gitInit(dir);
  // code-span terms are extracted structurally — no protectedTerms config
  // needed, so extraction is deterministic regardless of vocabulary.
  writeFileSync(path.join(dir, "s.md"), "Uses `OldTerm` for this.\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(path.join(dir, "s.md"), "Uses `NewTerm` for this.\n"); // OldTerm genuinely lost, renamed to NewTerm

  // Without --map-term: OldTerm is lost and uncovered → fails.
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 1);

  // With --map-term: the rename assertion covers the loss → passes.
  assert.equal(
    runLossAudit(dir, [
      "--base",
      "HEAD",
      "--map-term",
      "OldTerm=NewTerm",
      "s.md",
    ]),
    0,
  );
});

test("accept upserts on (file, term): a second call with a new reason replaces, not duplicates", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));

  assert.equal(
    runLossAccept(dir, [
      "s.md",
      "--term",
      "HogQL",
      "--reason",
      "first reason",
      "--base",
      "HEAD",
      "--dropped",
    ]),
    0,
  );
  assert.equal(
    runLossAccept(dir, [
      "s.md",
      "--term",
      "HogQL",
      "--reason",
      "second reason",
      "--base",
      "HEAD",
      "--dropped",
    ]),
    0,
  );

  const cfg = JSON.parse(readFileSync(path.join(dir, "loom.json"), "utf8"));
  const matches = cfg.lint.lossAcceptances.filter(
    (a: { file: string; term: string }) =>
      a.file === "s.md" && a.term === "HogQL",
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].reason, "second reason");
});

// --- accept must prove, not assert -------------------------------------------
// A reason is prose. "consolidated into X" reads as evidence and is not: the
// tool used to record it verbatim without ever opening X. That is how content
// disappears behind a green gate — the one failure the whole audit exists to
// prevent.

test("accept refuses when neither --verified-in nor --dropped is given", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  assert.throws(
    () =>
      runLossAccept(dir, ["s.md", "--term", "HogQL", "--reason", "moved to X"]),
    /--verified-in|--dropped/,
  );
});

test("accept refuses --verified-in and --dropped together", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () =>
      runLossAccept(dir, [
        "s.md",
        "--term",
        "HogQL",
        "--reason",
        "r",
        "--dropped",
        "--verified-in",
        "other.md",
      ]),
    /not both/,
  );
});

test("accept refuses --verified-in when the destination lacks the term", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  writeFileSync(path.join(dir, "other.md"), "Nothing relevant here.\n");
  assert.throws(
    () =>
      runLossAccept(dir, [
        "s.md",
        "--term",
        "HogQL",
        "--reason",
        "consolidated into other.md",
        "--verified-in",
        "other.md",
      ]),
    /does not contain/,
  );
});

test("accept refuses --verified-in pointing at a file that does not exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  assert.throws(
    () =>
      runLossAccept(dir, [
        "s.md",
        "--term",
        "HogQL",
        "--reason",
        "moved",
        "--verified-in",
        "ghost.md",
      ]),
    /no such file/,
  );
});

test("accept records where it verified the term, so the claim stays auditable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "acc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "s.md"), "Uses `HogQL`.\n");
  g("add", "-A");
  g("commit", "-qm", "b");
  writeFileSync(
    path.join(dir, "loom.json"),
    JSON.stringify({ schema: 1, lint: { protectedTerms: ["HogQL"] } }),
  );
  writeFileSync(path.join(dir, "s.md"), "Rewritten.\n");
  writeFileSync(path.join(dir, "other.md"), "It really moved: `HogQL`.\n");
  assert.equal(
    runLossAccept(dir, [
      "s.md",
      "--term",
      "HogQL",
      "--reason",
      "consolidated into other.md",
      "--verified-in",
      "other.md",
    ]),
    0,
  );
  const cfg = JSON.parse(readFileSync(path.join(dir, "loom.json"), "utf8"));
  assert.deepEqual(cfg.lint.lossAcceptances[0].verifiedIn, ["other.md"]);
  assert.equal(runLossAudit(dir, ["--base", "HEAD", "s.md"]), 0);
});

// --- a section that moved must leave a trace ---------------------------------
// Word retention stays high and no protected term goes missing when a section
// moves between documents, so the row read `ok` and the move left no trace at
// all. Heading names were tried as the signal and lied ("## Workflow" exists in
// half a vault); exact body text was tried and never fired (a moved section is
// almost always reworded). Shingle overlap is what separates them.

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void chunks.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

function relocVault() {
  const dir = mkdtempSync(path.join(tmpdir(), "reloc-"));
  const g = gitInit(dir);
  writeFileSync(path.join(dir, "loom.json"), JSON.stringify({ schema: 1 }));
  writeFileSync(
    path.join(dir, "a.md"),
    "# A\n\nIntro.\n\n## Graph refresh\n\n" +
      "The refresh replaces the touched subgraph atomically rather than adding to it, " +
      "because an additive update leaves stale knowledge behind. It removes the old " +
      "nodes for the touched families, re-extracts their folders grouped by family, " +
      "inserts the fresh nodes and edges, drops the edges left dangling, and validates " +
      "that no identifier is duplicated and no edge points at a missing node.\n",
  );
  g("add", "-A");
  g("commit", "-qm", "b");
  return dir;
}

test("loss-audit: a section moved to another file is named, with its score", () => {
  const dir = relocVault();
  writeFileSync(path.join(dir, "a.md"), "# A\n\nIntro.\n");
  // Reworded on the way, as a real move always is.
  writeFileSync(
    path.join(dir, "b.md"),
    "# B\n\n## Graph refresh\n\n" +
      "This refresh replaces the touched subgraph atomically rather than adding to it, " +
      "since an additive update leaves stale knowledge behind. It removes the old " +
      "nodes for the touched families, re-extracts their folders grouped by family, " +
      "inserts the fresh nodes and edges, drops the edges left dangling, and checks " +
      "that no identifier is duplicated and no edge points at a missing node.\n",
  );
  const out = captureStdout(() =>
    runLossAudit(dir, ["--base", "HEAD", "a.md"]),
  );
  assert.match(out, /relocated: ## Graph refresh -> b\.md \(\d+%\)/);
});

test("loss-audit: an unrelated section sharing a heading is not a relocation", () => {
  const dir = relocVault();
  writeFileSync(path.join(dir, "a.md"), "# A\n\nIntro.\n");
  writeFileSync(
    path.join(dir, "unrelated.md"),
    "# U\n\n## Graph refresh\n\n" +
      "Completely different prose about scheduling nightly backups to the network " +
      "share, retention windows, and how the operator is notified when a run fails " +
      "or is skipped because the target was unreachable at the time.\n",
  );
  const out = captureStdout(() =>
    runLossAudit(dir, ["--base", "HEAD", "a.md"]),
  );
  assert.ok(!out.includes("relocated"), "must not claim a bogus destination");
});

test("loss-audit: a section reworded in place is not reported as moved", () => {
  const dir = relocVault();
  writeFileSync(
    path.join(dir, "a.md"),
    "# A\n\nIntro.\n\n## Subgraph refresh\n\n" +
      "The refresh replaces the touched subgraph atomically rather than adding to it, " +
      "because an additive update leaves stale knowledge behind. It removes the old " +
      "nodes for the touched families, re-extracts their folders grouped by family, " +
      "inserts the fresh nodes and edges, drops the edges left dangling, and validates " +
      "that no identifier is duplicated and no edge points at a missing node.\n",
  );
  const out = captureStdout(() =>
    runLossAudit(dir, ["--base", "HEAD", "a.md"]),
  );
  assert.ok(!out.includes("relocated"), "renaming a heading is not a move");
});

test("headings ignore fenced code blocks", async () => {
  const { headings } = await import("../src/loss.js");
  const md =
    "# Real\n\n```bash\n# 2. pack the tarball\nnpm pack\n```\n\n## Also real\n";
  assert.deepEqual(headings(md), ["# Real", "## Also real"]);
});

// --- hooks that ship but never run -------------------------------------------
// core.hooksPath lives in .git/config, which no clone inherits. A repo can carry
// its hooks in a tracked .githooks/ and have them silently inert on every other
// machine — the file travels, the activation does not.

function vaultWithHooks(): string {
  const vault = makeTmp();
  makeConfig(vault, {});
  gitInit(vault);
  mkdirSync2(path.join(vault, ".githooks"));
  writeFileSync(path.join(vault, ".githooks", "post-commit"), "#!/bin/sh\n");
  return vault;
}

test("doctor flags hooks that ship in .githooks but are not wired to git", async () => {
  const { runDoctor } = await import("../src/commands/doctor.js");
  const vault = vaultWithHooks();
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    runDoctor(vault);
  } finally {
    console.error = orig;
  }
  assert.ok(
    errs.some((e) => e.includes("core.hooksPath")),
    "expected doctor to say the hooks are not running",
  );
});

test("doctor stays quiet once core.hooksPath is set", async () => {
  const { runDoctor } = await import("../src/commands/doctor.js");
  const vault = vaultWithHooks();
  spawnSync("git", ["-C", vault, "config", "core.hooksPath", ".githooks"]);
  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    runDoctor(vault);
  } finally {
    console.error = orig;
  }
  assert.ok(!errs.some((e) => e.includes("core.hooksPath")));
});
