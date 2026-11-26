import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createUiServer,
  humanizeName,
  wireSources,
  aggregateHealth,
  buildState,
} from "../src/server.js";
import { makeTmp, makeSkill, makeConfig } from "./helpers.js";
import { saveConfig, loadConfig, DEFAULT_IGNORE } from "../src/config.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

test("POST /api/add: legacy top-level domain/layer still populate taxonomy (src/ui.js compat)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const post = (body: object) =>
    fetch(`${base}/api/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const wet = await post({
    name: "legacy-demo",
    description: "From the legacy form fields",
    domain: "cross",
    layer: "skill",
    apply: true,
  });
  assert.equal(wet.status, 200);
  const md = readFileSync2(path.join(vault, "legacy-demo", "SKILL.md"), "utf8");
  assert.match(md, /^domain: cross$/m);
  assert.match(md, /^layer: skill$/m);
  server.close();
});

test("POST /api/add: a vault that declared away domain/layer ignores the legacy top-level fields instead of 500ing (#2)", async () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    taxonomy: { area: {}, kind: {} },
  });
  const { server, base } = await start(vault);
  const wet = await postJson(base, "/api/add", {
    name: "declared-axes-demo",
    description: "From an external pre-axes caller",
    domain: "cross",
    layer: "skill",
    apply: true,
  });
  assert.equal(wet.status, 200);
  const md = readFileSync2(
    path.join(vault, "declared-axes-demo", "SKILL.md"),
    "utf8",
  );
  assert.ok(!/^domain:/m.test(md));
  assert.ok(!/^layer:/m.test(md));
  server.close();
});

test("POST /api/archive: dry-run then apply", async () => {
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

test("GET /api/skill hides git-ignored files, keeps untracked ones", async () => {
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  writeFileSync2(path.join(vault, ".gitignore"), "__pycache__/\n*.pyc\n");
  mkdirSync(path.join(dir, "scripts", "__pycache__"), { recursive: true });
  writeFileSync2(
    path.join(dir, "scripts", "__pycache__", "gate.cpython-311.pyc"),
    "junk",
  );
  writeFileSync2(path.join(dir, "scripts", "gate.py"), "print()");
  for (const args of [
    ["init"],
    ["add", "-A"],
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
  ])
    spawnSync("git", ["-C", vault, ...args], { encoding: "utf8" });
  // untracked and not ignored: unsaved work, must stay visible
  writeFileSync2(path.join(dir, "draft.md"), "# wip");

  const { server, base } = await start(vault);
  const body = (await (await fetch(`${base}/api/skill?name=alpha`)).json()) as {
    files: { path: string }[];
  };
  const paths = body.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "SKILL.md",
    "draft.md",
    path.join("scripts", "gate.py"),
  ]);
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

test("an image answers with a URL, whatever its size, and the raw route serves the bytes", async () => {
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  // Past the JSON payload cap: a photo in a skill's assets/ is routinely
  // megabytes, and used to be reported as an unviewable binary.
  const bytes = Buffer.alloc(1_500_000, 7);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync2(path.join(dir, "assets", "photo.png"), bytes);
  const { server, base } = await start(vault);
  try {
    const meta = (await (
      await fetch(`${base}/api/file?name=alpha&path=assets/photo.png`)
    ).json()) as { kind: string; size: number; src: string; content?: string };
    assert.equal(meta.kind, "image");
    assert.equal(meta.size, bytes.length);
    // The bytes ride on their own URL, never inlined in the JSON.
    assert.equal(meta.content, undefined);
    const raw = await fetch(`${base}${meta.src}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.equal(raw.headers.get("cache-control"), "no-store");
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.equal(Buffer.from(await raw.arrayBuffer()).length, bytes.length);
    // The route is a viewer, not a general file reader: same guards as
    // /api/file, plus a refusal for anything that is not an image.
    assert.equal(
      (await fetch(`${base}/api/file-raw?name=alpha&path=SKILL.md`)).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/file-raw?name=alpha&path=../../loom.json`))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/file-raw?name=alpha&path=nope.png`)).status,
      404,
    );
    symlinkSync2("/etc/hostname", path.join(dir, "escape.png"));
    assert.equal(
      (await fetch(`${base}/api/file-raw?name=alpha&path=escape.png`)).status,
      400,
    );
  } finally {
    server.close();
  }
});

test("GET /api/file-download hands one file over as itself, named and attached", async () => {
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync2(path.join(dir, "assets", "città foto.png"), Buffer.alloc(64));
  const { server, base } = await start(vault);
  try {
    const md = await fetch(
      `${base}/api/file-download?name=alpha&path=SKILL.md`,
    );
    assert.equal(md.status, 200);
    // Attached, not rendered: a text file downloads instead of opening in a tab.
    assert.match(
      md.headers.get("content-disposition") ?? "",
      /^attachment; filename="SKILL\.md"/,
    );
    assert.match(await md.text(), /name: alpha/);
    // A name the header cannot carry verbatim rides on the UTF-8 form, with an
    // ASCII fallback for what only reads the plain one.
    const img = await fetch(
      `${base}/api/file-download?name=alpha&path=${encodeURIComponent("assets/città foto.png")}`,
    );
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/png");
    const cd = img.headers.get("content-disposition") ?? "";
    assert.match(cd, /filename="citt_ foto\.png"/);
    assert.match(cd, /filename\*=UTF-8''citt%C3%A0%20foto\.png/);
    // Same guards as the routes it sits beside.
    assert.equal(
      (await fetch(`${base}/api/file-download?name=alpha&path=../../loom.json`))
        .status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/file-download?name=alpha&path=nope.md`)).status,
      404,
    );
  } finally {
    server.close();
  }
});

test("GET /api/source-file-raw serves a read-only source image, listed paths only", async () => {
  const vault = makeTmp();
  makeSkill(vault, "", "alpha");
  const rt = path.join(makeTmp(), "skills");
  mkdirSync(rt, { recursive: true });
  const dir = makeSkill(rt, "", "solo");
  const bytes = Buffer.alloc(1_500_000, 3);
  writeFileSync2(path.join(dir, "photo.png"), bytes);
  makeConfig(vault, { vibe: rt });
  const { server, base } = await start(vault);
  try {
    const meta = (await (
      await fetch(
        `${base}/api/source-file?src=vibe&group=(unbundled)&name=solo&path=photo.png`,
      )
    ).json()) as { kind: string; src: string; content?: string };
    assert.equal(meta.kind, "image");
    assert.equal(meta.content, undefined);
    const raw = await fetch(`${base}${meta.src}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await raw.arrayBuffer()).length, bytes.length);
    // A path the skill does not list is not readable, same as /api/source-file.
    assert.equal(
      (
        await fetch(
          `${base}/api/source-file-raw?src=vibe&group=(unbundled)&name=solo&path=../photo.png`,
        )
      ).status,
      400,
    );
  } finally {
    server.close();
  }
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
  // A universal acronym belongs to the app's dictionary, not to a vault's
  // `names`: every vault that ships a cv-something skill would otherwise have
  // to teach the same word again.
  assert.equal(humanizeName("cv-tailoring"), "CV Tailoring");
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

test("buildState: exposes declared axes and per-axis skill fields", () => {
  const dir = makeTmp();
  writeFileSync2(
    path.join(dir, "loom.json"),
    JSON.stringify({
      consumers: {},
      taxonomy: { domain: { values: ["cross"] }, area: {}, kind: {} },
    }),
  );
  mkdirSync(path.join(dir, "alpha"), { recursive: true });
  writeFileSync2(
    path.join(dir, "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: d\ndomain: cross\narea: governance-quality\nkind: operator\n---\n\n# alpha\n",
  );
  const st = buildState(dir) as any;
  assert.deepEqual(
    st.axes.map((a: any) => a.id),
    ["domain", "area", "kind"],
  );
  const s = st.skills.find((x: any) => x.name === "alpha");
  assert.equal(s.domain, "cross");
  assert.equal(s.area, "governance-quality");
  assert.equal(s.kind, "operator");
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

test("POST /api/rules preserves a lint key outside the dashboard's 9 fields", async () => {
  // The dashboard's Rules pane only knows 9 lint fields (see normalizedLint
  // in src/ui.js) and always sends exactly that shape — never structuredDocs
  // or absolutePathIgnoreFiles. A save through this route must not let those
  // fields fall out of loom.json just because the dashboard doesn't render
  // them: that's the ratchet (draft-vs-active ratchet in test/vault.test.ts)
  // silently disarming itself on the next unrelated "Save rules" click.
  const vault = makeTmp();
  const structuredDocs = [{ file: "live-state.md", requireTable: true }];
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { descriptionMinChars: 3, structuredDocs },
  });
  const { server, base } = await start(vault);
  // Exactly the 9-field shape normalizedLint() in src/ui.js builds and
  // rulesConfirmClick() posts — no structuredDocs, no absolutePathIgnoreFiles.
  const dashboardLint = {
    requireTaxonomy: [],
    allowedDomains: [],
    allowedLayers: [],
    requireSections: [],
    descriptionMinChars: 42,
    descriptionMaxChars: null,
    bodyMaxLines: null,
    forbidBodyPatterns: [],
    strict: false,
  };
  const r = (await (
    await fetch(`${base}/api/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lint: dashboardLint, apply: true }),
    })
  ).json()) as { ok: boolean };
  server.close();
  assert.equal(r.ok, true);
  const saved = JSON.parse(
    readFileSync2(path.join(vault, "loom.json"), "utf8"),
  );
  // the field the dashboard edited actually changed...
  assert.equal(saved.lint.descriptionMinChars, 42);
  // ...but the field the dashboard doesn't know about must survive intact.
  assert.deepEqual(saved.lint.structuredDocs, structuredDocs);
});

test("saving lint from the UI leaves the taxonomy block untouched", () => {
  // The taxonomy block is top-level config, not part of the lint block the
  // Rules editor writes. POST /api/rules builds its write as
  // {...loadConfig(vaultDir), lint: {...}} (see the route above) — this
  // pins that exact pattern directly against saveConfig, so a Rules save
  // can never silently drop a declared taxonomy block for a vault that has
  // moved on to declared axes.
  const vault = makeTmp();
  const taxonomy = { domain: { values: ["cross"] }, area: {} };
  writeFileSync2(
    path.join(vault, "loom.json"),
    JSON.stringify({ consumers: {}, taxonomy, lint: { strict: false } }),
  );
  saveConfig(vault, { ...loadConfig(vault), lint: { strict: true } } as any);
  const after = JSON.parse(
    readFileSync2(path.join(vault, "loom.json"), "utf8"),
  );
  assert.deepEqual(after.taxonomy, taxonomy);
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

test("readBody rejects a non-object JSON body with 400, not a 500 crash (#15)", async () => {
  const { vault } = uiVault();
  makeSkill(vault, "biz", "demo");
  const { server, base } = await start(vault);
  // A valid-JSON but non-object body (null) used to reach the handler and crash
  // it at body.<field> (→ 500). It must be rejected up front as a 400.
  const r = await postJson(base, "/api/link-toggle", null);
  assert.equal(r.status, 400);
  const j = (await r.json()) as { error?: string };
  assert.match(j.error ?? "", /object/);
  server.close();
});

test("GET /api/skill rejects a path-traversal name (#34)", async () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  makeConfig(vault, { claude: consumerDir });
  // A SKILL.md reachable from .archive only via `..` traversal.
  const escaped = path.join(vault, "escaped");
  mkdirSync(escaped, { recursive: true });
  writeFileSync2(
    path.join(escaped, "SKILL.md"),
    "---\nname: escaped\ndescription: x\n---\n\n# escaped\n",
  );
  const { server, base } = await start(vault);
  const r = await fetch(
    `${base}/api/skill?name=${encodeURIComponent("../escaped")}`,
  );
  assert.equal(r.status, 404);
  server.close();
});

test("GET /api/skill returns the frontmatter block for a CRLF SKILL.md (#16)", async () => {
  const vault = makeTmp();
  const consumerDir = path.join(makeTmp(), "skills");
  makeConfig(vault, { claude: consumerDir });
  const dir = path.join(vault, "biz", "crlf-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync2(
    path.join(dir, "SKILL.md"),
    "---\r\nname: crlf-skill\r\ndescription: x\r\n---\r\n\r\n# CRLF\r\n",
  );
  const { server, base } = await start(vault);
  const j = (await (
    await fetch(`${base}/api/skill?name=crlf-skill`)
  ).json()) as { frontmatter: string };
  assert.match(j.frontmatter, /name: crlf-skill/);
  server.close();
});

test("POST /api/consumers adds a runtime and rejects a bad name (#34)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const ok = (await (
    await postJson(base, "/api/consumers", { name: "vibe", path: "/tmp/x" })
  ).json()) as { consumers: Record<string, string> };
  assert.equal(ok.consumers.vibe, "/tmp/x");
  const bad = await postJson(base, "/api/consumers", {
    name: "Bad Name",
    path: "/tmp/x",
  });
  assert.equal(bad.status, 400);
  server.close();
});

test("POST /api/names edits the casing map and validates the word (#34)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  const ok = (await (
    await postJson(base, "/api/names", { word: "api", cased: "API" })
  ).json()) as { names: Record<string, string> };
  assert.equal(ok.names.api, "API");
  const bad = await postJson(base, "/api/names", {
    word: "two words",
    cased: "X",
  });
  assert.equal(bad.status, 400);
  server.close();
});

test("POST /api/bulk/{taxonomy,archive,restore} dry-run and validation (#34)", async () => {
  const { vault } = uiVault();
  // Flat skill (vault/<name>): setFieldOp/bulkTaxonomyOp resolve vault/<name>.
  const d = path.join(vault, "alpha");
  mkdirSync(d, { recursive: true });
  writeFileSync2(
    path.join(d, "SKILL.md"),
    "---\nname: alpha\ndescription: test skill\n---\n\n# alpha\n",
  );
  const { server, base } = await start(vault);
  const tax = await postJson(base, "/api/bulk/taxonomy", {
    names: ["alpha"],
    field: "domain",
    value: "biz",
    apply: false,
  });
  assert.equal(tax.status, 200); // dry-run ok
  const taxBad = await postJson(base, "/api/bulk/taxonomy", {
    names: ["alpha"],
    field: "nope",
    value: "biz",
  });
  assert.equal(taxBad.status, 400);
  const arch = await postJson(base, "/api/bulk/archive", {
    names: ["alpha"],
    apply: false,
  });
  assert.equal(arch.status, 200);
  const restBad = await postJson(base, "/api/bulk/restore", { names: [] });
  assert.equal(restBad.status, 400);
  server.close();
});

test("GET /api/doc-history and /api/doc-commit validate name and hash (#34)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  assert.equal(
    (await fetch(`${base}/api/doc-history?name=loom.json`)).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/api/doc-history?name=../escape`)).status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/doc-commit?name=loom.json&hash=zzz`)).status,
    400,
  );
  server.close();
});

test("GET /api/sources sends each group's count, so the client can size it without the names", async () => {
  const vault = makeTmp();
  makeSkill(vault, "", "alpha");
  // A runtime with two natives of its own: one group, count 2, no name list.
  const rt = path.join(makeTmp(), "skills");
  mkdirSync(rt, { recursive: true });
  makeSkill(rt, "", "one");
  makeSkill(rt, "", "two");
  makeConfig(vault, { vibe: rt });
  const { server, base } = await start(vault);
  try {
    const body = (await (await fetch(`${base}/api/sources`)).json()) as {
      sources: {
        id: string;
        count: number;
        groups: { key: string; count?: number; skills?: string[] }[];
      }[];
    };
    const vibe = body.sources.find((s) => s.id === "vibe");
    assert.equal(vibe?.count, 2);
    assert.deepEqual(
      vibe?.groups.map((g) => [g.key, g.count]),
      [["(unbundled)", 2]],
    );
    // The chip bar only needs sizes; the names ride on /api/source-skills.
    assert.equal(vibe?.groups[0].skills, undefined);
  } finally {
    server.close();
  }
});

test("GET /api/source-file needs the right group, so one name in two groups cannot cross over", async () => {
  const vault = makeTmp();
  makeSkill(vault, "", "alpha");
  const rt = path.join(makeTmp(), "skills");
  mkdirSync(rt, { recursive: true });
  makeSkill(rt, "", "solo");
  makeConfig(vault, { vibe: rt });
  const { server, base } = await start(vault);
  try {
    const ok = await fetch(
      `${base}/api/source-file?src=vibe&group=(unbundled)&name=solo&path=SKILL.md`,
    );
    assert.equal(ok.status, 200);
    // Right skill, wrong group: refused rather than served from elsewhere.
    const wrong = await fetch(
      `${base}/api/source-file?src=vibe&group=nope&name=solo&path=SKILL.md`,
    );
    assert.equal(wrong.status, 404);
    // The name guard still holds ahead of the group lookup.
    const esc = await fetch(
      `${base}/api/source-file?src=vibe&group=(unbundled)&name=../../etc&path=SKILL.md`,
    );
    assert.equal(esc.status, 404);
  } finally {
    server.close();
  }
});

test("humanizeName reads smb as an acronym", () => {
  assert.equal(humanizeName("smb-router"), "SMB Router");
  assert.equal(humanizeName("smb-onboard"), "SMB Onboard");
});

test("wireSources humanizes a group's label and sends its size, not its names", () => {
  const wired = wireSources(
    [
      {
        id: "claude",
        label: ".claude",
        kind: "runtime",
        dir: "/x/skills",
        count: 3,
        axis: "Plugin",
        groups: [
          {
            key: "small-business",
            label: "small-business",
            skills: [
              { name: "smb-router", dir: "/x/sb" },
              { name: "call-list", dir: "/x/sb" },
            ],
          },
          {
            key: "(unbundled)",
            label: "Unbundled",
            skills: [{ name: "a", dir: "/x/skills" }],
          },
        ],
      },
    ],
    {},
  );
  // The key stays machine-readable (it addresses the group); the label is the
  // only part meant for reading.
  assert.deepEqual(wired[0].groups, [
    { key: "small-business", label: "Small Business", count: 2 },
    { key: "(unbundled)", label: "Unbundled", count: 1 },
  ]);
});

// --- force sync must not be reachable from the network -----------------------
// --allow-remote-writes opens every write endpoint at once. `force` skips the
// doctor gate, commits the entire working tree and pushes it — fine for the
// operator at the machine, not for an unauthenticated caller across Tailscale.

test("forceSyncAllowed: loopback yes, anything else no", async () => {
  const { forceSyncAllowed } = await import("../src/server.js");
  for (const ok of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"])
    assert.equal(forceSyncAllowed(ok), true, `${ok} is local`);
  for (const no of ["100.64.0.7", "::ffff:100.64.0.7", "10.0.0.4", ""])
    assert.equal(forceSyncAllowed(no), false, `${no} is not local`);
});

// --- Instance branding: favicon assets ------------------------------------
// Served as binary. The existing serveAsset() reads utf8, which corrupts an
// .ico; these tests pin byte-for-byte identity so that never regresses.

function bundled(file: string): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src",
    file,
  );
}

async function startBranded(
  vaultDir: string,
  brandDir?: string,
): Promise<{ server: Server; base: string }> {
  const server = createUiServer(vaultDir, { brandDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("GET /favicon.ico serves the bundled icon byte-for-byte", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const res = await fetch(`${base}/favicon.ico`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/x-icon");
    const got = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(got, readFileSync2(bundled("favicon.ico")));
  } finally {
    server.close();
  }
});

test("GET /apple-touch-icon.png serves the bundled icon byte-for-byte", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const res = await fetch(`${base}/apple-touch-icon.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const got = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(got, readFileSync2(bundled("apple-touch-icon.png")));
  } finally {
    server.close();
  }
});

test("a brandDir favicon overrides the bundled one", async () => {
  const { vault } = uiVault();
  const brandDir = makeTmp();
  const custom = Buffer.from("not-a-real-ico-but-distinct-bytes");
  writeFileSync2(path.join(brandDir, "favicon.ico"), custom);
  const { server, base } = await startBranded(vault, brandDir);
  try {
    const res = await fetch(`${base}/favicon.ico`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), custom);
  } finally {
    server.close();
  }
});

test("a brandDir without the asset falls back to the bundled one", async () => {
  const { vault } = uiVault();
  const { server, base } = await startBranded(vault, makeTmp());
  try {
    const res = await fetch(`${base}/favicon.ico`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      readFileSync2(bundled("favicon.ico")),
    );
  } finally {
    server.close();
  }
});

test("the page links its apple-touch-icon (browsers only auto-find /favicon.ico)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(
      html,
      /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/,
    );
  } finally {
    server.close();
  }
});

test("the page links /favicon.ico explicitly (not just by convention)", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const html = await (await fetch(`${base}/`)).text();
    // An explicit <link rel="icon"> lets a browser notice the icon changed;
    // convention-only /favicon.ico stays stuck on a cached blank.
    assert.match(html, /<link rel="icon" href="\/favicon\.ico"/);
  } finally {
    server.close();
  }
});

// Chrome renders a typed PNG <link rel="icon"> more reliably than a PNG-in-ICO
// and picks the size it needs; the .ico stays as a legacy fallback.
for (const [file, mime] of [
  ["favicon-32.png", "image/png"],
  ["favicon-16.png", "image/png"],
] as const) {
  test(`GET /${file} serves the bundled icon byte-for-byte`, async () => {
    const { vault } = uiVault();
    const { server, base } = await start(vault);
    try {
      const res = await fetch(`${base}/${file}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), mime);
      assert.deepEqual(
        Buffer.from(await res.arrayBuffer()),
        readFileSync2(bundled(file)),
      );
    } finally {
      server.close();
    }
  });
}

test("a brandDir overrides the sized PNG favicons too", async () => {
  const { vault } = uiVault();
  const brandDir = makeTmp();
  const custom = Buffer.from("distinct-32");
  writeFileSync2(path.join(brandDir, "favicon-32.png"), custom);
  const { server, base } = await startBranded(vault, brandDir);
  try {
    assert.deepEqual(
      Buffer.from(await (await fetch(`${base}/favicon-32.png`)).arrayBuffer()),
      custom,
    );
  } finally {
    server.close();
  }
});

test("the page links the sized PNG favicons for browsers that prefer them", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(
      html,
      /<link rel="icon" type="image\/png" sizes="32x32" href="\/favicon-32\.png"/,
    );
    assert.match(
      html,
      /<link rel="icon" type="image\/png" sizes="16x16" href="\/favicon-16\.png"/,
    );
  } finally {
    server.close();
  }
});

test("GET /api/graph-freshness reports no graph, then reads the status file", async () => {
  const vault = makeTmp();
  makeConfig(vault, { claude: makeTmp() });
  const { server, base } = await start(vault);
  try {
    // No graphify-out yet -> hasGraph false.
    const r0 = (await (await fetch(`${base}/api/graph-freshness`)).json()) as {
      hasGraph: boolean;
    };
    assert.equal(r0.hasGraph, false);

    // Add a graph + a status file with one stuck family.
    mkdirSync(path.join(vault, "graphify-out"), { recursive: true });
    writeFileSync2(
      path.join(vault, "graphify-out", "graph.json"),
      '{"nodes":[]}',
    );
    writeFileSync2(
      path.join(vault, "graphify-out", ".refresh-status.json"),
      JSON.stringify({
        updated_at: "2026-07-24T10:00:00+02:00",
        pending: {
          skill: { state: "stuck", fails: 3, reason: "no chunk: timeout" },
        },
      }),
    );
    const r1 = (await (await fetch(`${base}/api/graph-freshness`)).json()) as {
      hasGraph: boolean;
      pending: { family: string; state: string; command: string }[];
    };
    assert.equal(r1.hasGraph, true);
    assert.equal(r1.pending.length, 1);
    assert.equal(r1.pending[0].family, "skill");
    assert.equal(r1.pending[0].state, "stuck");
    assert.equal(r1.pending[0].command, "graphify-refresh.py skill");
  } finally {
    server.close();
  }
});

test("assets are gzipped when the client accepts it, and identical either way", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    // ui.css + ui.js + icons.js are ~810KB uncompressed; over Tailscale that is
    // the whole first paint. The bytes must survive the round trip unchanged.
    const gz = await fetch(base + "/ui.css", {
      headers: { "accept-encoding": "gzip" },
    });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    assert.equal(gz.headers.get("vary"), "accept-encoding");
    const plain = await fetch(base + "/ui.css", {
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(plain.headers.get("content-encoding"), null);
    // fetch() decodes gzip transparently: same text, fewer bytes on the wire.
    assert.equal(await gz.text(), await plain.text());
  } finally {
    server.close();
  }
});

test("a client that cannot take gzip still gets the page", async () => {
  const { vault } = uiVault();
  const { server, base } = await start(vault);
  try {
    const r = await fetch(base + "/", {
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-encoding"), null);
    assert.match(await r.text(), /<title>Skill Loom<\/title>/);
  } finally {
    server.close();
  }
});

test("a line-delimited JSON log is text, not a binary file", async () => {
  // `.jsonl` is what a generation log is written as, and the viewer answered
  // "Binary file, 244.9 KB" for it: the extension was simply missing from the
  // text set, so a readable file was refused for the shape of its name.
  const { vault } = uiVault();
  const dir = makeSkill(vault, "cat", "alpha");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync2(path.join(dir, "assets", "runs.jsonl"), '{"a":1}\n{"a":2}\n');
  const { server, base } = await start(vault);
  try {
    const body = (await (
      await fetch(`${base}/api/file?name=alpha&path=assets/runs.jsonl`)
    ).json()) as { kind: string; content: string };
    assert.equal(body.kind, "text");
    assert.match(body.content, /"a":2/);
  } finally {
    server.close();
  }
});
