import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  syncStatus,
  syncOp,
  syncFiles,
  setRemote,
  pullFailureMessage,
} from "../src/sync.js";
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

test("syncOp: un vault non-git esce 2", () => {
  assert.equal(syncOp(makeTmp(), true).status, 2);
});

test("syncOp senza remote: versiona in locale invece di errore", () => {
  // Vault git valido ma senza origin: un commit dev'essere possibile lo stesso.
  const local = makeTmp();
  initRepo(local);
  makeConfig(local, {});
  makeSkill(local, "cat", "alpha");
  git(local, "add", "-A");
  git(local, "commit", "-q", "-m", "baseline", "--no-verify");

  // pulito → nessuna azione, exit 0 (non è un errore)
  assert.equal(syncOp(local, true).status, 0);

  // modifica pendente → dry-run mostra "commit ... locally", apply committa
  writeFileSync(
    path.join(local, "cat", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: edited\n---\n\n# alpha\n",
  );
  const dry = syncOp(local, false);
  assert.equal(dry.status, 0);
  assert.ok(dry.actions.some((x) => /local/i.test(x)));
  assert.notEqual(git(local, "status", "--porcelain").stdout.trim(), ""); // dry-run non tocca
  const wet = syncOp(local, true);
  assert.equal(wet.status, 0);
  assert.match(wet.message, /local/i);
  assert.equal(git(local, "status", "--porcelain").stdout.trim(), ""); // committato
});

test("syncOp gate: blocca un commit che viola le regole; force sblocca", async () => {
  const { saveConfig, loadConfig } = await import("../src/config.js");
  const vault = makeTmp();
  initRepo(vault);
  makeConfig(vault, {});
  // strict: ogni skill deve avere `domain`
  saveConfig(vault, {
    ...loadConfig(vault),
    lint: { strict: true, requireTaxonomy: ["domain"] },
  });
  makeSkill(vault, "cat", "alpha"); // niente domain → viola lo strict
  // c'è roba da committare → il gate scatta e blocca
  const gated = syncOp(vault, true);
  assert.equal(gated.status, 1);
  assert.ok(gated.gate && gated.gate.length > 0);
  assert.notEqual(git(vault, "status", "--porcelain").stdout.trim(), ""); // non committato
  // force = "commit comunque" → bypassa il gate
  const forced = syncOp(vault, true, true);
  assert.equal(forced.status, 0);
  assert.equal(git(vault, "status", "--porcelain").stdout.trim(), ""); // committato
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

test("setRemote refuses a vault nested inside a larger repo (won't touch the parent origin)", () => {
  const parent = makeTmp();
  initRepo(parent);
  const vault = path.join(parent, "vault");
  mkdirSync(vault);
  makeConfig(vault, {});
  const r = setRemote(vault, "https://example.com/v.git", true);
  assert.equal(r.status, 2);
  assert.notEqual(git(parent, "remote", "get-url", "origin").status, 0);
});

test("syncFiles maps dirty, outgoing and incoming paths", () => {
  const { a, b } = twoClones();
  // outgoing: commit a change in A without pushing
  writeFileSync(
    path.join(a, "cat/alpha/SKILL.md"),
    "---\nname: alpha\n---\n\n# v2\n",
  );
  git(a, "add", "-A");
  git(a, "commit", "-q", "-m", "edit alpha", "--no-verify");
  // dirty: an uncommitted file in A
  writeFileSync(path.join(a, "cat/alpha/notes.md"), "wip\n");
  const fa = syncFiles(a);
  assert.ok(fa.dirty.includes("cat/alpha/notes.md"));
  assert.ok(fa.outgoing.includes("cat/alpha/SKILL.md"));
  // incoming: B pushes, A fetches
  writeFileSync(path.join(b, "beta.md"), "hello\n");
  git(b, "add", "-A");
  git(b, "commit", "-q", "-m", "add beta", "--no-verify");
  git(b, "push", "-q", "origin", "main");
  git(a, "fetch", "-q", "origin");
  const fa2 = syncFiles(a);
  assert.ok(fa2.incoming.includes("beta.md"));
});

test("syncOp attributes a git add failure to add, not a masked commit (#24)", () => {
  const vault = makeTmp();
  initRepo(vault);
  makeConfig(vault, {});
  makeSkill(vault, "cat", "alpha");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "base", "--no-verify");
  writeFileSync(
    path.join(vault, "cat", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: changed now\n---\n\n# alpha\n",
  );
  // Block the index so `git add -A` fails deterministically (root-safe: git
  // refuses when index.lock already exists, regardless of file permissions).
  writeFileSync(path.join(vault, ".git", "index.lock"), "");
  const out = syncOp(vault, true, true);
  assert.equal(out.status, 1);
  assert.match(out.message, /^git add failed/);
});

test("pullFailureMessage separates a real rebase conflict from other failures (#23)", () => {
  assert.match(
    pullFailureMessage(true, { stderr: "", stdout: "" }),
    /rebase stopped on a conflict/,
  );
  const other = pullFailureMessage(false, {
    stderr: "fatal: Could not read from remote repository",
    stdout: "",
  });
  assert.match(other, /^pull failed: fatal: Could not read from remote/);
});

// --- "0 ahead / 0 behind" must not mean "could not tell" ---------------------
// With no upstream, rev-list fails and the counters stay at their initial 0.
// That reads as "in sync" on every surface, and offers nothing to push or pull.
// A real vault sat 135 ahead and 137 behind for nine days under that reading.

test("syncOp: untracked branch whose remote counterpart exists refuses to guess", () => {
  const { a } = twoClones();
  // Same shape as a history rewrite: origin/main is there, tracking is not.
  git(a, "branch", "--unset-upstream");
  const res = syncOp(a, false);
  assert.equal(res.status, 1);
  assert.match(res.message, /UNKNOWN, not zero/);
  assert.match(res.message, /set-upstream-to/);
});

test("syncOp: no upstream and no branch on the remote is bootstrap, not divergence", () => {
  // The first push establishes tracking; there is nothing to be out of sync
  // with, so this path must stay open.
  const bare = path.join(makeTmp(), "remote.git");
  mkdirSync(bare);
  git(bare, "init", "-q", "--bare", "-b", "main");
  const v = path.join(makeTmp(), "fresh");
  mkdirSync(v);
  initRepo(v);
  makeConfig(v, {});
  makeSkill(v, "cat", "alpha");
  git(v, "remote", "add", "origin", bare);
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "baseline", "--no-verify");
  assert.equal(syncOp(v, true).status, 0);
});

test("syncStatus reports upstream:false so callers can say unknown", () => {
  const { a } = twoClones();
  assert.equal(syncStatus(a).upstream, true);
  git(a, "branch", "--unset-upstream");
  assert.equal(syncStatus(a).upstream, false);
});
