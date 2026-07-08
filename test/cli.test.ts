import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
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
  assert.ok(existsSync(path.join(vault, "archive")));
  assert.equal(runInit(vault), 2);
});

test("add scaffolds SKILL.md, rejects invalid and duplicate names", async () => {
  const { runInit } = await import("../src/commands/init.js");
  const { runAdd } = await import("../src/commands/add.js");
  const vault = makeTmp();
  runInit(vault);
  assert.equal(runAdd(vault, "my-skill", "business"), 0);
  const md = readFileSync(
    path.join(vault, "business", "my-skill", "SKILL.md"),
    "utf8",
  );
  assert.match(md, /^name: my-skill$/m);
  assert.equal(runAdd(vault, "My_Skill", undefined), 2);
  assert.equal(runAdd(vault, "my-skill", undefined), 2);
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

test("archive: dry-run touches nothing; --apply moves skill, unlinks, records in loom.json", async () => {
  const { runArchive } = await import("../src/commands/archive.js");
  const { runLink } = await import("../src/commands/link.js");
  const { loadConfig } = await import("../src/config.js");
  const { vault, consumerDir } = vaultWithConsumer();
  makeSkill(vault, "cat", "alpha");
  runLink(vault, true);
  assert.equal(runArchive(vault, "alpha", "superseded", false), 0);
  assert.ok(existsSync(path.join(vault, "cat", "alpha"))); // dry-run: untouched
  assert.equal(runArchive(vault, "alpha", "superseded", true), 0);
  assert.ok(existsSync(path.join(vault, "archive", "alpha", "SKILL.md")));
  assert.ok(!existsSync(path.join(vault, "cat", "alpha")));
  assert.ok(
    !lstatSync(path.join(consumerDir, "alpha"), { throwIfNoEntry: false }),
  );
  assert.deepEqual(
    loadConfig(vault).archived.map((a) => [a.name, a.reason]),
    [["alpha", "superseded"]],
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
