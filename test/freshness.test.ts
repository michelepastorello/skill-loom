import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTmp } from "./helpers.js";
import { readGraphFreshness, staleFamilies } from "../src/freshness.js";

function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// A vault with a graphify-out/ dir. `graph` toggles the graph.json presence.
function makeVault(opts: { graph?: boolean } = {}): string {
  const v = makeTmp();
  mkdirSync(path.join(v, "graphify-out"), { recursive: true });
  if (opts.graph !== false)
    writeFileSync(path.join(v, "graphify-out", "graph.json"), '{"nodes":[]}');
  return v;
}

function initRepo(v: string): string {
  git(v, "init", "-q", "-b", "main");
  git(v, "config", "user.email", "t@t");
  git(v, "config", "user.name", "t");
  git(v, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(v, "a.txt"), "1");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "c1", "--no-verify");
  return git(v, "rev-parse", "HEAD").stdout.trim();
}

// Markdown di una skill, non file qualunque: dal momento in cui "behind" conta
// solo i commit che possono cambiare il grafo, un .txt non muoverebbe il numero.
function commitMore(v: string, n: number): string {
  mkdirSync(path.join(v, "alpha"), { recursive: true });
  for (let i = 0; i < n; i++) {
    writeFileSync(
      path.join(v, "alpha", `note${i}.md`),
      `---\nname: alpha\n---\n\n# alpha ${i}\n`,
    );
    git(v, "add", "-A");
    git(v, "commit", "-q", "-m", `more${i}`, "--no-verify");
  }
  return git(v, "rev-parse", "HEAD").stdout.trim();
}

function writeStatus(v: string, obj: unknown): void {
  writeFileSync(
    path.join(v, "graphify-out", ".refresh-status.json"),
    typeof obj === "string" ? obj : JSON.stringify(obj),
  );
}

test("no graph.json -> hasGraph false", () => {
  const v = makeVault({ graph: false });
  assert.deepEqual(readGraphFreshness(v), { hasGraph: false });
});

test("fresh: empty pending, fresh sha == HEAD -> pending [], commitsBehind 0", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    updated_at: "2026-07-24T10:00:00+02:00",
    pending: {},
  });
  const r = readGraphFreshness(v);
  assert.equal(r.hasGraph, true);
  if (!r.hasGraph) return;
  assert.deepEqual(r.pending, []);
  assert.equal(r.commitsBehind, 0);
  assert.equal(r.freshThroughCommit, head);
  assert.equal(r.updatedAt, "2026-07-24T10:00:00+02:00");
});

test("pending family -> normalized entry with command", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    updated_at: "x",
    pending: {
      skill: {
        state: "pending",
        fails: 1,
        reason: "skill skill-audit degenere 17->4n",
        last_attempt: "y",
      },
    },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.pending.length, 1);
  assert.deepEqual(r.pending[0], {
    family: "skill",
    state: "pending",
    fails: 1,
    reason: "skill skill-audit degenere 17->4n",
    lastAttempt: "y",
    command: "graphify-refresh.py skill",
  });
});

test("stuck family -> state stuck, fails preserved, command built", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    pending: { vps: { state: "stuck", fails: 3, reason: "no chunk: timeout" } },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.pending[0].state, "stuck");
  assert.equal(r.pending[0].fails, 3);
  assert.equal(r.pending[0].command, "graphify-refresh.py vps");
});

test("behind-only: empty pending, HEAD ahead by 2 -> commitsBehind 2, pending []", () => {
  const v = makeVault();
  const base = initRepo(v);
  commitMore(v, 2);
  writeStatus(v, { fresh_through_commit: base, pending: {} });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.commitsBehind, 2);
  assert.deepEqual(r.pending, []);
});

test("fresh sha not an ancestor of HEAD -> commitsBehind null", () => {
  const v = makeVault();
  initRepo(v);
  // 40-hex sha that isn't in this repo's history
  writeStatus(v, { fresh_through_commit: "0".repeat(40), pending: {} });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.commitsBehind, null);
});

test("not a git repo -> commitsBehind null, rest populated", () => {
  const v = makeVault();
  writeStatus(v, {
    fresh_through_commit: "abc123",
    updated_at: "z",
    pending: {},
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.commitsBehind, null);
  assert.equal(r.updatedAt, "z");
  assert.equal(r.freshThroughCommit, "abc123");
});

test("corrupt status.json + graph present -> hasGraph, updatedAt null, fallback to .last-refresh-sha", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, "{ this is not json");
  writeFileSync(path.join(v, "graphify-out", ".last-refresh-sha"), head + "\n");
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.updatedAt, null);
  assert.deepEqual(r.pending, []);
  assert.equal(r.freshThroughCommit, head);
  assert.equal(r.commitsBehind, 0);
});

test("unknown state dropped; fails non-number -> 0", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    pending: {
      good: { state: "pending", fails: "nope", reason: "r" },
      bogus: { state: "weird", fails: 2 },
    },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].family, "good");
  assert.equal(r.pending[0].fails, 0);
});

test("stuck sorts before pending", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    pending: {
      aaa: { state: "pending", fails: 1 },
      zzz: { state: "stuck", fails: 3 },
    },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.equal(r.pending[0].family, "zzz");
  assert.equal(r.pending[0].state, "stuck");
});

test("running refresh -> normalized progress contract", () => {
  const v = makeVault();
  const head = initRepo(v);
  writeStatus(v, {
    fresh_through_commit: head,
    pending: {},
    run: {
      state: "extracting",
      total: 5,
      completed: 2,
      workers: 3,
      families: ["alpha", "beta", "gamma", "delta", "epsilon"],
      last_completed: "beta",
      last_provider: "codex",
      started_at: "2026-07-26T19:00:00+02:00",
    },
  });

  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.deepEqual(r.run, {
    state: "extracting",
    total: 5,
    completed: 2,
    workers: 3,
    families: ["alpha", "beta", "gamma", "delta", "epsilon"],
    familyState: [],
    lastCompleted: "beta",
    lastProvider: "codex",
    startedAt: "2026-07-26T19:00:00+02:00",
    finishedAt: null,
    cross: null,
  });
});

test("cross-linking progress is parsed and malformed blocks render as absent", () => {
  const v = makeVault();
  writeStatus(v, {
    run: {
      state: "applying",
      total: 2,
      completed: 2,
      cross: {
        done: 13,
        total: 79,
        current: ["editorial-voice", "skill-authoring"],
      },
    },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.deepStrictEqual(r.run?.cross, {
    done: 13,
    total: 79,
    current: ["editorial-voice", "skill-authoring"],
  });

  // Il file di stato è scritto da uno script esterno: un blocco malformato deve
  // sparire, mai diventare NaN di progresso.
  writeStatus(v, {
    run: { state: "applying", total: 2, completed: 2, cross: { done: "x" } },
  });
  const bad = readGraphFreshness(v);
  if (!bad.hasGraph) return assert.fail("hasGraph");
  assert.strictEqual(bad.run?.cross, null);
});

test("a status file from the serial pipeline still names its one live skill", () => {
  // Il campo era una stringa quando la passata era una sola: un file scritto
  // prima dell'aggiornamento non deve far sparire la riga viva dal pannello.
  const v = makeVault();
  writeStatus(v, {
    run: {
      state: "applying",
      total: 2,
      completed: 2,
      cross: { done: 13, total: 79, current: "editorial-voice" },
    },
  });
  const r = readGraphFreshness(v);
  if (!r.hasGraph) return assert.fail("hasGraph");
  assert.deepStrictEqual(r.run?.cross?.current, ["editorial-voice"]);
});

test("per-family run state is parsed and ordered by what needs attention", () => {
  const v = makeVault();
  initRepo(v);
  writeFileSync(
    path.join(v, "graphify-out", ".refresh-status.json"),
    JSON.stringify({
      pending: {},
      run: {
        state: "extracting",
        total: 4,
        completed: 2,
        workers: 3,
        families: ["alpha", "beta", "gamma", "delta"],
        family_state: {
          alpha: {
            state: "done",
            skills: 9,
            seconds: 212.4,
            provider: "codex",
          },
          beta: { state: "queued", skills: 3 },
          gamma: { state: "running", skills: 2 },
          delta: { state: "failed", skills: 2, reason: "degenerate chunk" },
          junk: { state: "not-a-state" },
        },
      },
    }),
  );
  const f = readGraphFreshness(v);
  assert.equal(f.hasGraph, true);
  if (!f.hasGraph) return;
  assert.deepEqual(
    f.run?.familyState.map((x) => [x.family, x.state]),
    [
      ["delta", "failed"],
      ["gamma", "running"],
      ["beta", "queued"],
      ["alpha", "done"],
    ],
  );
  assert.equal(f.run?.familyState[3].seconds, 212.4);
  assert.equal(f.run?.familyState[0].reason, "degenerate chunk");
});

test("a status file without family state still parses, with an empty list", () => {
  const v = makeVault();
  initRepo(v);
  writeFileSync(
    path.join(v, "graphify-out", ".refresh-status.json"),
    JSON.stringify({ run: { state: "idle", total: 1, completed: 1 } }),
  );
  const f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.deepEqual(f.run?.familyState, []);
});

test("stale families come from git, one entry per family, newest first", () => {
  const v = makeVault();
  const base = initRepo(v);
  mkdirSync(path.join(v, "wedding-brand-system"), { recursive: true });
  mkdirSync(path.join(v, "wedding-offering-pricing"), { recursive: true });
  mkdirSync(path.join(v, "noteplan"), { recursive: true });
  for (const s of [
    "wedding-brand-system",
    "wedding-offering-pricing",
    "noteplan",
  ])
    writeFileSync(path.join(v, s, "SKILL.md"), "---\nname: x\n---\n");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skills", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(path.join(v, "wedding-brand-system", "SKILL.md"), "changed 1");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "c1", "--no-verify");
  writeFileSync(
    path.join(v, "wedding-offering-pricing", "SKILL.md"),
    "changed 2",
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "c2", "--no-verify");
  writeFileSync(path.join(v, "noteplan", "SKILL.md"), "changed 3");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "c3", "--no-verify");

  const all = staleFamilies(v, fresh);
  assert.deepEqual(
    all.map((s) => [s.family, s.skills.length, s.commits]),
    [
      ["wedding", 2, 2],
      ["noteplan", 1, 1],
    ],
  );
  assert.equal(all[0].command, "graphify-refresh.py wedding");
  // A family already in the run is in flight, not silently stale.
  assert.deepEqual(
    staleFamilies(v, fresh, ["wedding"]).map((s) => s.family),
    ["noteplan"],
  );
  assert.equal(base.length > 0, true);
});

test("a file the pipeline never extracts does not make a family stale", () => {
  const v = makeVault();
  initRepo(v);
  mkdirSync(path.join(v, "skill-loom", "scripts"), { recursive: true });
  writeFileSync(
    path.join(v, "skill-loom", "SKILL.md"),
    "---\nname: skill-loom\n---\n",
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skill", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();
  // live-state.md and everything under scripts/ are excluded by the pipeline's
  // own predicate, so a refresh would never clear them.
  writeFileSync(path.join(v, "skill-loom", "live-state.md"), "churn");
  writeFileSync(path.join(v, "skill-loom", "scripts", "notes.md"), "notes");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "noise", "--no-verify");
  assert.deepEqual(staleFamilies(v, fresh), []);

  writeFileSync(path.join(v, "skill-loom", "SKILL.md"), "real change");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "real", "--no-verify");
  assert.deepEqual(
    staleFamilies(v, fresh).map((s) => s.family),
    ["skill"],
  );
});

test("a cosmetic frontmatter change does not make a family stale", () => {
  // La pipeline scarta un file che fra base e HEAD cambia SOLO per chiavi
  // cosmetiche ("solo frontmatter cosmetico — skip"): elencarlo qui accende una
  // riga che nessun refresh toccherà mai, e che sparisce solo perché a fine
  // giro il driver avanza comunque `fresh_through_commit`.
  const v = makeVault();
  initRepo(v);
  mkdirSync(path.join(v, "noteplan"), { recursive: true });
  const before =
    "---\nname: noteplan\nicon: file-text\nicon-color: blue-500\nstatus: active\n---\n\n# noteplan\n\nIl corpo.\n";
  writeFileSync(path.join(v, "noteplan", "SKILL.md"), before);
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skill", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();

  writeFileSync(
    path.join(v, "noteplan", "SKILL.md"),
    before
      .replace("icon: file-text", "icon: pen-tool")
      .replace("icon-color: blue-500", "icon-color: amber-500")
      .replace("status: active", "status: draft"),
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "icona", "--no-verify");

  assert.deepEqual(staleFamilies(v, fresh), []);
});

test("a body change alongside the cosmetic keys is still stale", () => {
  const v = makeVault();
  initRepo(v);
  mkdirSync(path.join(v, "noteplan"), { recursive: true });
  const before =
    "---\nname: noteplan\nicon-color: blue-500\n---\n\n# noteplan\n\nIl corpo.\n";
  writeFileSync(path.join(v, "noteplan", "SKILL.md"), before);
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skill", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();

  writeFileSync(
    path.join(v, "noteplan", "SKILL.md"),
    before
      .replace("icon-color: blue-500", "icon-color: amber-500")
      .replace("Il corpo.", "Il corpo, riscritto."),
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "corpo", "--no-verify");

  assert.deepEqual(
    staleFamilies(v, fresh).map((s) => s.family),
    ["noteplan"],
  );
});

test("editing the body without committing flips the same file back to stale", () => {
  // Il confronto è contro il file SUL DISCO: la cache che evita un `git show`
  // per file a ogni giro della dashboard non deve servire la risposta di prima.
  const v = makeVault();
  initRepo(v);
  mkdirSync(path.join(v, "noteplan"), { recursive: true });
  const before =
    "---\nname: noteplan\nicon-color: blue-500\n---\n\n# noteplan\n\nIl corpo.\n";
  writeFileSync(path.join(v, "noteplan", "SKILL.md"), before);
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skill", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(
    path.join(v, "noteplan", "SKILL.md"),
    before.replace("icon-color: blue-500", "icon-color: amber-500"),
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "icona", "--no-verify");
  assert.deepEqual(staleFamilies(v, fresh), []);

  // Stesso commit, stesso base: cambia solo il file sul disco.
  writeFileSync(
    path.join(v, "noteplan", "SKILL.md"),
    before.replace("Il corpo.", "Il corpo riscritto a mano, non committato."),
  );
  assert.deepEqual(
    staleFamilies(v, fresh).map((s) => s.family),
    ["noteplan"],
  );
});

test("a skill added after the build commit is stale even with no base version", () => {
  // `git show <base>:<file>` non esiste per un file nuovo: l'assenza di una
  // versione precedente non è un cambio cosmetico, è tutto da estrarre.
  const v = makeVault();
  initRepo(v);
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();
  mkdirSync(path.join(v, "noteplan"), { recursive: true });
  writeFileSync(
    path.join(v, "noteplan", "SKILL.md"),
    "---\nname: noteplan\nicon-color: blue-500\n---\n\n# noteplan\n",
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "nuova", "--no-verify");

  assert.deepEqual(
    staleFamilies(v, fresh).map((s) => s.family),
    ["noteplan"],
  );
});

test("stale is empty when the build commit is unknown to this history", () => {
  const v = makeVault();
  initRepo(v);
  assert.deepEqual(staleFamilies(v, "0".repeat(40)), []);
  assert.deepEqual(staleFamilies(v, null), []);
});

test("a running family reports when it started, not only how long it took", () => {
  const v = makeVault();
  initRepo(v);
  writeFileSync(
    path.join(v, "graphify-out", ".refresh-status.json"),
    JSON.stringify({
      pending: {},
      run: {
        state: "extracting",
        total: 2,
        completed: 0,
        family_state: {
          alpha: {
            state: "running",
            skills: 3,
            started_at: "2026-07-27T16:15:26+02:00",
          },
          beta: { state: "done", skills: 1, seconds: 12 },
        },
      },
    }),
  );
  const f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  const [running, done] = f.run!.familyState;
  assert.equal(running.startedAt, "2026-07-27T16:15:26+02:00");
  assert.equal(running.seconds, null);
  assert.equal(done.startedAt, null);
  assert.equal(done.seconds, 12);
});

test("a commit that cannot change the graph does not count as behind", () => {
  const v = makeVault();
  initRepo(v);
  mkdirSync(path.join(v, "alpha", "scripts"), { recursive: true });
  writeFileSync(path.join(v, "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "skill", "--no-verify");
  const fresh = git(v, "rev-parse", "HEAD").stdout.trim();
  writeFileSync(
    path.join(v, "graphify-out", ".refresh-status.json"),
    JSON.stringify({
      fresh_through_commit: fresh,
      pending: {},
    }),
  );

  // Solo script e live-state: il grafo non ne dipende.
  writeFileSync(path.join(v, "alpha", "scripts", "tool.py"), "print(1)\n");
  writeFileSync(path.join(v, "alpha", "live-state.md"), "churn\n");
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "tooling", "--no-verify");
  let f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.equal(f.commitsBehind, 0);

  // Un vero cambio di contenuto invece conta.
  writeFileSync(
    path.join(v, "alpha", "SKILL.md"),
    "---\nname: alpha\n---\nnuovo\n",
  );
  git(v, "add", "-A");
  git(v, "commit", "-q", "-m", "content", "--no-verify");
  f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.equal(f.commitsBehind, 1);
});

test("an armed refresh is reported, and a forgotten marker is not", () => {
  const v = makeVault();
  initRepo(v);
  const armed = path.join(v, "graphify-out", ".refresh-armed");
  const now = Math.floor(Date.now() / 1000);

  writeFileSync(armed, String(now + 90));
  let f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.equal(f.armedAt, now + 90);

  // Un worker ucciso lascia il marker (succede: il restart del servizio che ha
  // committato porta giu' anche il suo worker). Passata la scadenza smette di
  // promettere un refresh.
  writeFileSync(armed, String(now - 120));
  f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.equal(f.armedAt, null);

  writeFileSync(armed, "non un numero");
  f = readGraphFreshness(v);
  if (!f.hasGraph) throw new Error("expected a graph");
  assert.equal(f.armedAt, null);
});
