import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { syncStatus, syncOp, setRemote } from "../src/sync.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";

function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}
function initRepo(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@local");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}
// bare remote + due cloni configurati
function twoClones(): { bare: string; a: string; b: string } {
  const bare = path.join(makeTmp(), "remote.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const a = path.join(makeTmp(), "vault-a");
  mkdirSync(a);
  initRepo(a);
  makeConfig(a, {});
  makeSkill(a, "cat", "alpha");
  git(a, "remote", "add", "origin", bare);
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "baseline", "--no-verify");
  git(a, "push", "-q", "-u", "origin", "main");
  const parentB = makeTmp();
  spawnSync("git", ["clone", "-q", bare, path.join(parentB, "vault-b")], {
    encoding: "utf8",
  });
  const b = path.join(parentB, "vault-b");
  initRepo(b); // set user config on the clone too
  return { bare, a, b };
}

test("syncStatus: non-git, no-remote, clean-with-remote", () => {
  const plain = makeTmp();
  assert.equal(syncStatus(plain).versioned, false);
  const noRemote = makeTmp();
  initRepo(noRemote);
  const st1 = syncStatus(noRemote);
  assert.equal(st1.versioned, true);
  assert.equal(st1.remote, null);
  const { a } = twoClones();
  const st2 = syncStatus(a);
  assert.equal(st2.versioned, true);
  assert.ok(st2.remote);
  assert.equal(st2.dirty, 0);
  assert.equal(st2.ahead, 0);
});

test("syncOp: exit 2 senza git o senza remote", () => {
  assert.equal(syncOp(makeTmp(), true).status, 2);
  const noRemote = makeTmp();
  initRepo(noRemote);
  assert.equal(syncOp(noRemote, true).status, 2);
});

test("syncOp: dry-run non tocca, apply committa e pusha, il clone riceve", () => {
  const { a, b } = twoClones();
  writeFileSync(
    path.join(a, "cat", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: updated\n---\n\n# alpha\n",
  );
  const dry = syncOp(a, false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.some((x) => x.includes("commit")));
  assert.equal(git(a, "status", "--porcelain").stdout.trim() === "", false); // ancora dirty
  const wet = syncOp(a, true);
  assert.equal(wet.status, 0);
  assert.equal(git(a, "status", "--porcelain").stdout.trim(), "");
  // b sincronizza e riceve la modifica
  const wetB = syncOp(b, true);
  assert.equal(wetB.status, 0);
  assert.match(
    readFileSync(path.join(b, "cat", "alpha", "SKILL.md"), "utf8"),
    /updated/,
  );
});

test("syncOp: già in sync → nessuna azione; divergenza compatibile → rebase ok", () => {
  const { a, b } = twoClones();
  const clean = syncOp(a, true);
  assert.equal(clean.status, 0);
  assert.equal(clean.actions.length, 0);
  // a e b divergono su file diversi → rebase pulito
  writeFileSync(path.join(a, "from-a.md"), "a\n");
  assert.equal(syncOp(a, true).status, 0);
  writeFileSync(path.join(b, "from-b.md"), "b\n");
  assert.equal(syncOp(b, true).status, 0);
  assert.equal(syncOp(a, true).status, 0); // a riceve from-b
  assert.ok(existsSync(path.join(a, "from-b.md")));
});

test("syncOp: conflitto di rebase → exit 1, messaggio guida", () => {
  const { a, b } = twoClones();
  writeFileSync(
    path.join(a, "cat", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: from A\n---\n",
  );
  assert.equal(syncOp(a, true).status, 0);
  writeFileSync(
    path.join(b, "cat", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: from B\n---\n",
  );
  const out = syncOp(b, true);
  assert.equal(out.status, 1);
  assert.match(out.message, /rebase/i);
  git(b, "rebase", "--abort"); // pulizia fixture
});

test("syncOp bootstrap: git init + remote add (no clone) establishes tracking on first sync", () => {
  const bare = path.join(makeTmp(), "remote2.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const v = path.join(makeTmp(), "vault-boot");
  mkdirSync(v);
  initRepo(v);
  makeConfig(v, {});
  makeSkill(v, "cat", "boot");
  git(v, "remote", "add", "origin", bare);
  // first sync: commits and pushes, establishing upstream
  assert.equal(syncOp(v, true).status, 0);
  const st = syncStatus(v);
  assert.equal(st.ahead, 0); // upstream now resolvable: counts are real zeros, not silent failures
  // a second machine pushes a change; the bootstrapped vault must SEE and PULL it
  const parentC = makeTmp();
  spawnSync("git", ["clone", "-q", bare, path.join(parentC, "vault-c")], {
    encoding: "utf8",
  });
  const c = path.join(parentC, "vault-c");
  initRepo(c);
  writeFileSync(path.join(c, "from-c.md"), "c\n");
  assert.equal(syncOp(c, true).status, 0);
  const pull = syncOp(v, true);
  assert.equal(pull.status, 0);
  assert.ok(existsSync(path.join(v, "from-c.md")));
});

test("setRemote sets origin on a versioned vault; rejects empty/non-git", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  initRepo(vault);
  const dry = setRemote(vault, "https://example.com/v.git", false);
  assert.equal(dry.status, 0);
  const wet = setRemote(vault, "https://example.com/v.git", true);
  assert.equal(wet.status, 0);
  assert.match(
    git(vault, "remote", "get-url", "origin").stdout,
    /example\.com\/v\.git/,
  );
  assert.equal(setRemote(vault, "", true).status, 2);
  assert.equal(setRemote(makeTmp(), "x", true).status, 2);
});
