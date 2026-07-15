import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  rmSync,
} from "node:fs";
import path from "node:path";
import { main } from "../src/main.js";
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
  assert.equal(runArchive(vault, "alpha", "superseded", false), 0);
  assert.ok(existsSync(path.join(vault, "cat", "alpha"))); // dry-run: untouched
  assert.equal(runArchive(vault, "alpha", "superseded", true), 0);
  assert.ok(existsSync(path.join(vault, ".archive", "alpha", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, "cat", "alpha")));
  assert.ok(
    !lstatSync(path.join(consumerDir, "alpha"), { throwIfNoEntry: false }),
  );
  assert.equal(runArchive(vault, "alpha", undefined, true), 2); // not found anymore
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
