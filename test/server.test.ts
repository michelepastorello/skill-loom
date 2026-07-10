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
} from "../src/server.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";
import { spawnSync } from "node:child_process";
import {
  symlinkSync as symlinkSync2,
  writeFileSync as writeFileSync2,
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

test("POST /api/add with a path-escaping category returns 400 and writes nothing outside the vault", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const outside = path.join(path.dirname(path.dirname(vault)), "outside");
  const res = await fetch(`${base}/api/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "evil",
      category: "../../outside",
      apply: true,
    }),
  });
  assert.equal(res.status, 400);
  assert.ok(!existsSync(outside));
  server.close();
});

test("POST /api/add: dry-run untouched, apply scaffolds, invalid name 400", async () => {
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
    category: "cat",
    description: "From the UI",
    apply: false,
  });
  assert.equal(dry.status, 200);
  assert.ok(!existsSync(path.join(vault, "cat", "demo")));
  const wet = await post({
    name: "demo",
    category: "cat",
    description: "From the UI",
    apply: true,
  });
  assert.equal(wet.status, 200);
  assert.ok(existsSync(path.join(vault, "cat", "demo", "SKILL.md")));
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
  assert.ok(existsSync(path.join(vault, "archive", "alpha", "SKILL.md")));

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
  assert.ok(existsSync(path.join(vault, "archive", "demo")));
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
