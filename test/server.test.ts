import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createUiServer,
  humanizeName,
  aggregateHealth,
  buildState,
} from "../src/server.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";
import { saveConfig, DEFAULT_IGNORE } from "../src/config.js";
import { spawnSync } from "node:child_process";
import {
  symlinkSync as symlinkSync2,
  writeFileSync as writeFileSync2,
  readFileSync as readFileSync2,
} from "node:fs";

async function start(
  vaultDir: string,
): Promise<{ server: Server; base: string }> {
  const server = createUiServer(vaultDir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

function uiVault() {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  makeConfig(vault, { claude: consumerDir });
  return { vault, consumerDir };
}

test("POST /api/inplace-toggle activates an in-place consumer by editing its config", async () => {
  const vault = makeTmp();
  const rtFile = path.join(makeTmp(), "rt.json");
  writeFileSync2(
    rtFile,
    JSON.stringify({ skills: { load: { extraDirs: [] } } }, null, 2) + "\n",
  );
  saveConfig(vault, {
    schema: 1,
    consumers: {
      rt: {
        mode: "in-place",
        servedVia: { file: rtFile, jsonPath: "skills.load.extraDirs" },
      },
    },
    ignore: [...DEFAULT_IGNORE],
    names: {},
  });
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);

  // inactive at first → the coverage state is "missing", not "served"
  const s0 = (await (await fetch(`${base}/api/state`)).json()) as {
    matrix: { consumer: string; state: string }[];
  };
  assert.equal(s0.matrix.find((m) => m.consumer === "rt")?.state, "missing");

  // dry-run lists the action, changes nothing
  const dry = await (
    await postJson(base, "/api/inplace-toggle", {
      consumer: "rt",
      on: true,
      apply: false,
    })
  ).json();
  assert.equal(dry.applied, false);
  assert.ok(dry.actions.length > 0);

  // apply → the vault lands in the runtime's array; coverage flips to served
  const on = await (
    await postJson(base, "/api/inplace-toggle", {
      consumer: "rt",
      on: true,
      apply: true,
    })
  ).json();
  assert.equal(on.applied, true);
  assert.deepEqual(
    JSON.parse(readFileSync2(rtFile, "utf8")).skills.load.extraDirs,
    [path.resolve(vault)],
  );
  const s1 = (await (await fetch(`${base}/api/state`)).json()) as {
    matrix: { consumer: string; state: string }[];
  };
  assert.equal(s1.matrix.find((m) => m.consumer === "rt")?.state, "served");

  // a non-in-place (or unknown) consumer is refused
  const bad = await postJson(base, "/api/inplace-toggle", {
    consumer: "ghost",
    on: true,
    apply: true,
  });
  assert.equal(bad.status, 400);
  server.close();
});

test("GET /api/doc serves a vault-root doc and blocks anything else", async () => {
  const { vault } = uiVault();
  writeFileSync2(path.join(vault, "CONVENTIONS.md"), "# Rules\n\nbody\n");
  const { server, base } = await start(vault);

  const ok = await fetch(`${base}/api/doc?name=CONVENTIONS.md`);
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { content: string; kind: string };
  assert.match(body.content, /# Rules/);

  // not an allowed governance doc
  assert.equal((await fetch(`${base}/api/doc?name=loom.json`)).status, 400);
  // path traversal
  assert.equal((await fetch(`${base}/api/doc?name=../secret`)).status, 400);
  // allowed name but absent
  assert.equal((await fetch(`${base}/api/doc?name=README.md`)).status, 404);
  server.close();
});

test("GET /api/state returns skills, matrix and problems", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/state`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    skills: { name: string }[];
    matrix: { skill: string; state: string }[];
    problems: unknown[];
  };
  assert.deepEqual(
    body.skills.map((s) => s.name),
    ["alpha"],
  );
  assert.equal(body.matrix[0]?.state, "missing");
  assert.deepEqual(body.problems, []);
  server.close();
});

test("state skills carry domain, layer and status (status defaults to active)", async () => {
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  writeFileSync2(
    path.join(dir, "SKILL.md"),
    "---\nname: alpha\ndomain: bottega19\nlayer: tool\nstatus: rebrand-needed\ndescription: x\n---\n\n# alpha\n",
  );
  makeSkill(vault, "cat", "beta"); // no taxonomy fields
  const { server, base } = await start(vault);
  const body = (await (await fetch(`${base}/api/state`)).json()) as {
    skills: {
      name: string;
      domain: string | null;
      layer: string | null;
      status: string;
    }[];
  };
  const a = body.skills.find((s) => s.name === "alpha");
  const b = body.skills.find((s) => s.name === "beta");
  assert.equal(a?.domain, "bottega19");
  assert.equal(a?.layer, "tool");
  assert.equal(a?.status, "rebrand-needed");
  assert.equal(b?.domain, null);
  assert.equal(b?.layer, null);
  assert.equal(b?.status, "active");
  server.close();
});

test("POST /api/link dry-run plans without touching fs; apply creates symlinks", async () => {
  const { vault, consumerDir } = uiVault();
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  const dry = await fetch(`${base}/api/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply: false }),
  });
  assert.equal(dry.status, 200);
  assert.ok(!existsSync(path.join(consumerDir, "alpha")));
  const wet = await fetch(`${base}/api/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply: true }),
  });
  assert.equal(wet.status, 200);
  assert.ok(lstatSync(path.join(consumerDir, "alpha")).isSymbolicLink());
  server.close();
});

test("POST /api/link with conflict returns 409 and leaves conflict intact", async () => {
  const { vault, consumerDir } = uiVault();
  makeSkill(vault, "cat", "bravo");
  mkdirSync(path.join(consumerDir, "bravo"), { recursive: true });
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply: true }),
  });
  assert.equal(res.status, 409);
  assert.ok(lstatSync(path.join(consumerDir, "bravo")).isDirectory());
  server.close();
});

test("GET /api/diff on a non-git vault reports versioned:false", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/diff`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { versioned: false });
  server.close();
});

test("invalid JSON body returns 400, unknown route 404", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const bad = await fetch(`${base}/api/link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{nope",
  });
  assert.equal(bad.status, 400);
  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);
  server.close();
});

test("POST with non-JSON content-type is rejected with 400", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/link`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ apply: false }),
  });
  assert.equal(res.status, 400);
  server.close();
});

test("POST /api/add: dry-run untouched, apply scaffolds at root, invalid name 400", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const post = (body: object) =>
    fetch(`${base}/api/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const dry = await post({
    name: "demo",
    description: "From the UI",
    apply: false,
  });
  assert.equal(dry.status, 200);
  assert.ok(!existsSync(path.join(vault, "demo")));
  const wet = await post({
    name: "demo",
    description: "From the UI",
    apply: true,
  });
  assert.equal(wet.status, 200);
  assert.ok(existsSync(path.join(vault, "demo", "SKILL.md")));
  const bad = await post({ name: "Bad_Name", apply: true });
  assert.equal(bad.status, 400);
  server.close();
});

test("POST /api/archive and /api/migrate: dry-run then apply", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "cat", "alpha");
  makeSkill(vault, "cat", "beta");
  const { server, base } = await start(vault);
  const post = (route: string, body: object) =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const aDry = await post("/api/archive", {
    name: "alpha",
    reason: "old",
    apply: false,
  });
  assert.equal(aDry.status, 200);
  assert.ok(existsSync(path.join(vault, "cat", "alpha")));
  const aWet = await post("/api/archive", {
    name: "alpha",
    reason: "old",
    apply: true,
  });
  assert.equal(aWet.status, 200);
  assert.ok(existsSync(path.join(vault, ".archive", "alpha", "SKILL.md")));

  const mDry = await post("/api/migrate", {
    old: "beta",
    new: "gamma",
    apply: false,
  });
  assert.equal(mDry.status, 200);
  assert.ok(existsSync(path.join(vault, "cat", "beta")));
  const mWet = await post("/api/migrate", {
    old: "beta",
    new: "gamma",
    apply: true,
  });
  assert.equal(mWet.status, 200);
  assert.ok(existsSync(path.join(vault, "cat", "gamma", "SKILL.md")));
  const missing = await post("/api/migrate", {
    old: "ghost",
    new: "delta",
    apply: true,
  });
  assert.equal(missing.status, 400);
  server.close();
});

test("GET / serves the self-contained dashboard page", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const html = await res.text();
  assert.match(html, /skill-loom/);
  assert.match(html, /id="app"/);
  // self-contained: no external stylesheet/script/font links (PRODUCT.md)
  assert.doesNotMatch(html, /href="https?:\/\//);
  assert.doesNotMatch(html, /src="https?:\/\//);
  server.close();
});

function gitify(dir: string): void {
  const run = (...args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@local");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  run("add", "-A");
  run("commit", "-q", "-m", "baseline", "--no-verify");
}

test("GET /api/skill returns files, states, category; 404 on unknown", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "cat", "alpha");
  writeFileSync2(path.join(vault, "cat", "alpha", "notes.txt"), "hello");
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/skill?name=alpha`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    category: string;
    files: { path: string; kind: string }[];
    states: { state: string }[];
  };
  assert.equal(body.category, "cat");
  assert.deepEqual(body.files.map((f) => f.path).sort(), [
    "SKILL.md",
    "notes.txt",
  ]);
  assert.equal(body.states.length, 1);
  assert.equal((await fetch(`${base}/api/skill?name=ghost`)).status, 404);
  server.close();
});

test("GET /api/file serves text, blocks traversal and symlink escape", async () => {
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  const ok = await fetch(`${base}/api/file?name=alpha&path=SKILL.md`);
  assert.equal(ok.status, 200);
  const okBody = (await ok.json()) as { kind: string; content: string };
  assert.equal(okBody.kind, "text");
  assert.match(okBody.content, /name: alpha/);
  assert.equal(
    (await fetch(`${base}/api/file?name=alpha&path=../../loom.json`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/file?name=alpha&path=nope.md`)).status,
    404,
  );
  symlinkSync2("/etc/hostname", path.join(dir, "escape.md"));
  assert.equal(
    (await fetch(`${base}/api/file?name=alpha&path=escape.md`)).status,
    400,
  );
  server.close();
});

test("GET /api/history and /api/commit: degrade without git, work with git", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  assert.deepEqual(
    await (await fetch(`${base}/api/history?name=alpha`)).json(),
    { versioned: false },
  );
  gitify(vault);
  const hist = (await (
    await fetch(`${base}/api/history?name=alpha`)
  ).json()) as {
    versioned: boolean;
    commits: { hash: string; date: string; subject: string }[];
  };
  assert.equal(hist.versioned, true);
  assert.ok(hist.commits.length >= 1);
  const hash = hist.commits[0]!.hash;
  const commit = (await (
    await fetch(`${base}/api/commit?name=alpha&hash=${hash}`)
  ).json()) as { diff: string };
  assert.match(commit.diff, /SKILL\.md/);
  assert.equal(
    (await fetch(`${base}/api/commit?name=alpha&hash=xyz!`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/commit?name=alpha&hash=deadbeef`)).status,
    400,
  );
  server.close();
});

test("state skills carry rel, description and modified", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  const body = (await (await fetch(`${base}/api/state`)).json()) as {
    skills: { rel: string; description: string; modified: string }[];
  };
  assert.equal(body.skills[0]?.rel, "cat/alpha");
  assert.equal(body.skills[0]?.description, "test skill");
  assert.match(body.skills[0]?.modified ?? "", /^\d{4}-\d{2}-\d{2}$/);
  server.close();
});

test("humanizeName and aggregateHealth follow the spec mapping", () => {
  assert.equal(humanizeName("alpha"), "Alpha");
  assert.equal(humanizeName("code-review"), "Code Review");
  assert.equal(humanizeName("svg-logo-designer"), "SVG Logo Designer");
  assert.equal(humanizeName("research-to-narrative"), "Research to Narrative");
  assert.equal(humanizeName("linkedin-analytics"), "LinkedIn Analytics");
  assert.equal(humanizeName("openclaw-checkpoint"), "OpenClaw Checkpoint");
  assert.equal(humanizeName("bottega19-crm"), "Bottega19 CRM");
  assert.equal(humanizeName("openai-tts"), "OpenAI TTS");
  assert.equal(humanizeName("gpt-image-2"), "GPT Image 2");
  assert.equal(humanizeName("ynab"), "YNAB");
  // custom names from loom.json win over the built-in dictionaries
  assert.equal(
    humanizeName("forpros-shop", { forpros: "ForPros" }),
    "ForPros Shop",
  );
  assert.equal(aggregateHealth(["linked", "linked"]), "active");
  assert.equal(aggregateHealth(["linked", "foreign"]), "attention");
  assert.equal(aggregateHealth(["linked", "missing"]), "attention");
  assert.equal(aggregateHealth(["missing"]), "inactive");
  assert.equal(aggregateHealth([]), "inactive");
  // "served" (in-place) counts as healthy, like "linked"
  assert.equal(aggregateHealth(["served"]), "active");
  assert.equal(aggregateHealth(["linked", "served"]), "active");
  assert.equal(aggregateHealth(["served", "foreign"]), "attention");
});

test("archived skills come from the archive/ folder and are browsable", async () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  makeSkill(vault, "cat", "active-one");
  // in archive/ but NOT recorded in loom.json's archived list
  makeSkill(vault, ".archive", "retired-one");

  const state = buildState(vault) as { archived: { name: string }[] };
  assert.deepEqual(
    state.archived.map((a) => a.name),
    ["retired-one"],
  );

  const { server, base } = await start(vault);
  const d = (await (
    await fetch(`${base}/api/skill?name=retired-one`)
  ).json()) as { archived: boolean; states: unknown[] };
  assert.equal(d.archived, true);
  assert.deepEqual(d.states, []); // archived → no live runtime links
  server.close();
});

test("buildState lists vault-root governance docs that exist", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  writeFileSync2(path.join(vault, "CONVENTIONS.md"), "# Rules\n");
  writeFileSync2(path.join(vault, "source-registry.yaml"), "roots: {}\n");
  const state = buildState(vault) as { docs: { name: string }[] };
  const names = state.docs.map((d) => d.name);
  assert.ok(names.includes("CONVENTIONS.md"));
  assert.ok(names.includes("source-registry.yaml"));
  assert.ok(!names.includes("README.md")); // absent → not listed
});

test("buildState surfaces hygiene warnings from the vault", () => {
  const vault = makeTmp();
  makeConfig(vault, {});
  const dir = makeSkill(vault, "cat", "alpha");
  // H1 drifts from the name → an h1-mismatch hygiene warning
  writeFileSync2(
    path.join(dir, "SKILL.md"),
    "---\nname: alpha\ndescription: d\n---\n\n# Not Alpha\n",
  );
  const state = buildState(vault) as { warnings: { kind: string }[] };
  assert.ok(state.warnings.some((w) => w.kind === "h1-mismatch"));
});

test("state skills carry title and health; GET/POST /api/sync work", async () => {
  const { vault, consumerDir } = uiVault();
  makeSkill(vault, "cat", "alpha");
  const { server, base } = await start(vault);
  const state = (await (await fetch(`${base}/api/state`)).json()) as {
    skills: { title: string; health: string }[];
  };
  assert.equal(state.skills[0]?.title, "Alpha");
  assert.equal(state.skills[0]?.health, "inactive");
  const st = (await (await fetch(`${base}/api/sync`)).json()) as {
    versioned: boolean;
  };
  assert.equal(st.versioned, false);
  const post = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apply: false }),
  });
  assert.equal(post.status, 400); // non-git → op status 2 → 400
  void consumerDir;
  server.close();
});

async function postJson(base: string, route: string, body: unknown) {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST /api/link-toggle activates a skill on a consumer; 400 on unknown", async () => {
  const { vault, consumerDir } = uiVault();
  makeSkill(vault, "biz", "demo");
  const { server, base } = await start(vault);

  const dry = await postJson(base, "/api/link-toggle", {
    consumer: "claude",
    name: "demo",
    on: true,
    apply: false,
  });
  assert.equal(dry.status, 200);
  const dj = await dry.json();
  assert.equal(dj.applied, false);
  assert.equal(dj.actions.length, 1);
  assert.ok(!existsSync(path.join(consumerDir, "demo")));

  const wet = await postJson(base, "/api/link-toggle", {
    consumer: "claude",
    name: "demo",
    on: true,
    apply: true,
  });
  assert.equal((await wet.json()).applied, true);
  assert.ok(lstatSync(path.join(consumerDir, "demo")).isSymbolicLink());

  const bad = await postJson(base, "/api/link-toggle", {
    consumer: "ghost",
    on: true,
    apply: false,
  });
  assert.equal(bad.status, 400);
  server.close();
});

test("POST /api/restore brings back an archived skill", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "biz", "demo");
  const { server, base } = await start(vault);
  await postJson(base, "/api/archive", {
    name: "demo",
    reason: "x",
    apply: true,
  });
  assert.ok(existsSync(path.join(vault, ".archive", "demo")));
  const wet = await postJson(base, "/api/restore", {
    name: "demo",
    apply: true,
  });
  assert.equal(wet.status, 200);
  assert.ok(existsSync(path.join(vault, "demo", "SKILL.md")));
  server.close();
});

test("POST /api/remote sets origin on a git vault", async () => {
  const { vault } = uiVault();
  spawnSync("git", ["-C", vault, "init", "-q"]);
  const { server, base } = await start(vault);
  const wet = await postJson(base, "/api/remote", {
    url: "https://example.com/x.git",
    apply: true,
  });
  assert.equal(wet.status, 200);
  const url = spawnSync("git", ["-C", vault, "remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  assert.match(url.stdout, /example\.com\/x\.git/);
  server.close();
});

test("POST /api/rules dry-run returns impact without writing", async () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { descriptionMinChars: 3 },
  });
  const dir = path.join(vault, "s1");
  mkdirSync(dir, { recursive: true });
  writeFileSync2(
    path.join(dir, "SKILL.md"),
    `---\nname: s1\ndescription: hey\n---\n\n# s1\n`,
  );
  const { server, base } = await start(vault);
  const r = (await (
    await fetch(`${base}/api/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lint: { descriptionMinChars: 10 }, apply: false }),
    })
  ).json()) as { ok: boolean; impact: { newlyFlagged: { name: string }[] } };
  server.close();
  assert.equal(r.ok, true);
  assert.equal(r.impact.newlyFlagged[0].name, "s1");
  const saved = JSON.parse(
    readFileSync2(path.join(vault, "loom.json"), "utf8"),
  );
  assert.equal(saved.lint.descriptionMinChars, 3); // unchanged
});

test("POST /api/rules apply writes the lint block", async () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { descriptionMinChars: 3 },
  });
  const { server, base } = await start(vault);
  const r = (await (
    await fetch(`${base}/api/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lint: { descriptionMinChars: 42 }, apply: true }),
    })
  ).json()) as { ok: boolean };
  server.close();
  assert.equal(r.ok, true);
  const saved = JSON.parse(
    readFileSync2(path.join(vault, "loom.json"), "utf8"),
  );
  assert.equal(saved.lint.descriptionMinChars, 42);
});

test("POST /api/rules rejects an invalid regex", async () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
  });
  const { server, base } = await start(vault);
  const res = await fetch(`${base}/api/rules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lint: { forbidBodyPatterns: ["[bad"] },
      apply: true,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error);
  server.close();
});

test("GET /api/loom-json returns the raw config file", async () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
  });
  const { server, base } = await start(vault);
  const r = (await (await fetch(`${base}/api/loom-json`)).json()) as {
    content: string;
  };
  server.close();
  assert.match(r.content, /"schema"/);
});

test("POST /api/bulk/status promotes many and links them; 400 on empty names", async () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  mkdirSync(consumerDir, { recursive: true });
  makeConfig(vault, { claude: consumerDir });
  const mk = (name: string, status: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync2(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\nstatus: ${status}\n---\n\n# ${name}\n`,
    );
  };
  mk("a", "draft");
  mk("b", "draft");
  const { server, base } = await start(vault);

  const dry = await (
    await postJson(base, "/api/bulk/status", {
      names: ["a", "b"],
      status: "active",
      apply: false,
    })
  ).json();
  assert.equal(dry.applied, false);
  assert.ok(dry.actions.length >= 2);

  const wet = await (
    await postJson(base, "/api/bulk/status", {
      names: ["a", "b"],
      status: "active",
      apply: true,
    })
  ).json();
  assert.equal(wet.applied, true);
  assert.ok(lstatSync(path.join(consumerDir, "a")).isSymbolicLink());
  assert.ok(lstatSync(path.join(consumerDir, "b")).isSymbolicLink());

  const bad = await postJson(base, "/api/bulk/status", {
    names: [],
    status: "active",
    apply: true,
  });
  assert.equal(bad.status, 400);
  server.close();
});

test("POST /api/bulk/rename applies a prefix transform", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "biz", "one");
  makeSkill(vault, "biz", "two");
  const { server, base } = await start(vault);
  const wet = await (
    await postJson(base, "/api/bulk/rename", {
      names: ["one", "two"],
      transform: { op: "add-prefix", value: "x-" },
      apply: true,
    })
  ).json();
  assert.equal(wet.applied, true);
  // migrateOp renames a skill in place, keeping its category folder ("biz/"),
  // matching the existing /api/migrate test (cat/gamma). The brief asserted a
  // vault-root path, which cannot hold against the shipped bulkRenameOp.
  assert.ok(existsSync(path.join(vault, "biz", "x-one", "SKILL.md")));
  // invalid transform is refused at the route
  const bad = await postJson(base, "/api/bulk/rename", {
    names: ["x-one"],
    transform: { op: "bogus" },
    apply: true,
  });
  assert.equal(bad.status, 400);
  server.close();
});
