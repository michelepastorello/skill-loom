import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTmp } from "./helpers.js";
import {
  familyOf,
  projectGraph,
  readVaultGraph,
  scanMentions,
} from "../src/graph.js";

const NEVER_BEHIND = () => null;

function skill(vault: string, name: string, body = ""): void {
  mkdirSync(path.join(vault, name), { recursive: true });
  writeFileSync(
    path.join(vault, name, "SKILL.md"),
    `---\nname: ${name}\n---\n\n# ${name}\n\n${body}\n`,
  );
}

function writeGraph(vault: string, dir: string, graph: unknown): void {
  mkdirSync(path.join(vault, dir), { recursive: true });
  writeFileSync(path.join(vault, dir, "graph.json"), JSON.stringify(graph));
}

function node(id: string, file: string, type = "concept", label = id) {
  return { id, source_file: file, file_type: type, label, community: 1 };
}

test("familyOf splits on the first dash, like the extraction pipeline", () => {
  assert.equal(familyOf("wedding-brand-system"), "wedding");
  assert.equal(familyOf("noteplan"), "noteplan");
});

test("no graph file leaves the vault shape but reports hasGraph false", () => {
  const v = makeTmp();
  skill(v, "alpha-one");
  skill(v, "alpha-two");
  skill(v, "solo");
  const g = projectGraph(v, ["alpha-one", "alpha-two", "solo"], NEVER_BEHIND);
  assert.equal(g.hasGraph, false);
  assert.equal(g.meta.families, 2);
  assert.equal(g.meta.singletonFamilies, 1);
  assert.equal(g.meta.skillsOnDisk, 3);
});

test("a corrupt graph degrades to no graph instead of throwing", () => {
  const v = makeTmp();
  skill(v, "alpha");
  mkdirSync(path.join(v, "graphify-out"), { recursive: true });
  writeFileSync(path.join(v, "graphify-out", "graph.json"), "{ not json");
  assert.equal(projectGraph(v, ["alpha"], NEVER_BEHIND).hasGraph, false);
});

test("nodes fold onto their skill folder and unknown folders are dropped", () => {
  const v = makeTmp();
  skill(v, "alpha");
  writeGraph(v, "graphify-out", {
    nodes: [
      node("a1", "alpha/SKILL.md", "document"),
      node("a2", "alpha/SKILL.md", "concept"),
      node("a3", "alpha/references/x.md", "rationale"),
      node("ghost", "retired-skill/SKILL.md", "concept"),
    ],
    links: [],
    built_at_commit: "abc123",
  });
  const g = projectGraph(v, ["alpha"], NEVER_BEHIND);
  assert.deepEqual(
    { ...g.skills.alpha, dupes: g.skills.alpha.dupes.length },
    { concept: 1, document: 1, rationale: 1, dupes: 0 },
  );
  assert.equal(g.skills["retired-skill"], undefined);
  assert.equal(g.meta.nodes, 4);
  assert.equal(g.meta.skillsIndexed, 1);
  assert.equal(g.meta.builtAtCommit, "abc123");
});

test("cross-skill links become one weighted pair with relations and samples", () => {
  const v = makeTmp();
  skill(v, "wedding-brand-system");
  skill(v, "wedding-offering-pricing");
  const nodes = [
    node("w1", "wedding-brand-system/SKILL.md", "concept", "Tone"),
    node("w2", "wedding-brand-system/SKILL.md", "concept", "Filter"),
    node("p1", "wedding-offering-pricing/SKILL.md", "concept", "Price"),
  ];
  writeGraph(v, "graphify-out", {
    nodes,
    links: [
      { source: "w1", target: "p1", relation: "references" },
      { source: "p1", target: "w2", relation: "references" },
      { source: "w2", target: "p1", relation: "hands-off-to" },
    ],
  });
  const g = projectGraph(
    v,
    ["wedding-brand-system", "wedding-offering-pricing"],
    NEVER_BEHIND,
  );
  assert.equal(g.edges.length, 1);
  const [edge] = g.edges;
  assert.equal(edge.a, "wedding-brand-system");
  assert.equal(edge.weight, 3);
  assert.deepEqual(edge.relations, { references: 2, "hands-off-to": 1 });
  assert.equal(edge.samples.length, 3);
  assert.equal(edge.samples[0].source, "Tone");
  assert.equal(g.meta.crossFamilyEdges, 0);
});

test("duplicates inside one skill are kept as merge candidates, not as edges", () => {
  const v = makeTmp();
  skill(v, "ynab");
  writeGraph(v, "graphify-out", {
    nodes: [
      node("t1", "ynab/SKILL.md", "concept", "Personal Access Token"),
      node("t2", "ynab/SKILL.md", "concept", "PAT authentication"),
    ],
    links: [{ source: "t1", target: "t2", relation: "duplicates" }],
  });
  const g = projectGraph(v, ["ynab"], NEVER_BEHIND);
  assert.equal(g.edges.length, 0);
  assert.deepEqual(g.skills.ynab.dupes, [
    ["Personal Access Token", "PAT authentication"],
  ]);
});

test("mentions need two occurrences and never count a skill naming itself", () => {
  const v = makeTmp();
  skill(v, "personal-brand-system", "See bottega19-brand-system for the hat.");
  skill(
    v,
    "bottega19-brand-system",
    "personal-brand-system covers the person.\nAgain: personal-brand-system.",
  );
  skill(v, "loner", "loner is loner.");
  const names = ["personal-brand-system", "bottega19-brand-system", "loner"];
  const mentions = scanMentions(v, names);
  assert.equal(mentions.length, 1);
  assert.deepEqual(
    { ...mentions[0] },
    {
      a: "bottega19-brand-system",
      b: "personal-brand-system",
      weight: 3,
      crossFamily: true,
    },
  );
});

test("a mention does not repeat a pair the extractor already produced", () => {
  const v = makeTmp();
  skill(v, "skill-refactor", "skill-schema, again skill-schema.");
  skill(v, "skill-schema", "");
  writeGraph(v, "graphify-out", {
    nodes: [
      node("r1", "skill-refactor/SKILL.md"),
      node("s1", "skill-schema/SKILL.md"),
    ],
    links: [{ source: "r1", target: "s1", relation: "references" }],
  });
  const g = projectGraph(v, ["skill-refactor", "skill-schema"], NEVER_BEHIND);
  assert.equal(g.edges.length, 1);
  assert.equal(g.mentions.length, 0);
});

test("word boundaries keep a longer skill name from matching a shorter one", () => {
  const v = makeTmp();
  skill(v, "skill", "");
  skill(v, "other", "skill-loom and skill-loom again");
  skill(v, "skill-loom", "");
  const mentions = scanMentions(v, ["skill", "other", "skill-loom"]);
  assert.deepEqual(
    mentions.map((m) => [m.a, m.b, m.weight]),
    [["other", "skill-loom", 2]],
  );
});

test("the code graph joins on the skill folder and reports its own freshness", () => {
  const v = makeTmp();
  skill(v, "personal-planning");
  writeGraph(v, "graphify-out", {
    nodes: [node("c1", "personal-planning/SKILL.md")],
    links: [],
  });
  writeGraph(v, "graphify-code", {
    nodes: [
      node("f1", "personal-planning/scripts/compute-drift.py", "code"),
      node("f2", "personal-planning/scripts/compute-drift.py", "code"),
      node("f3", "personal-planning/scripts/save-baseline.py", "code"),
      node("f4", "not-a-skill/x.py", "code"),
    ],
    links: [{ source: "f1", target: "f3", relation: "calls" }],
    built_at_commit: "cd94368",
  });
  const g = projectGraph(v, ["personal-planning"], (c) =>
    c === "cd94368" ? 14 : null,
  );
  assert.deepEqual(g.skills["personal-planning"].code, {
    nodes: 3,
    files: [
      { path: "scripts/compute-drift.py", nodes: 2 },
      { path: "scripts/save-baseline.py", nodes: 1 },
    ],
  });
  assert.deepEqual(g.meta.code, {
    nodes: 4,
    edges: 1,
    skills: 1,
    builtAtCommit: "cd94368",
    commitsBehind: 14,
  });
});

test("no code graph leaves the code meta null rather than faking a zero", () => {
  const v = makeTmp();
  skill(v, "alpha");
  writeGraph(v, "graphify-out", {
    nodes: [node("a1", "alpha/SKILL.md")],
    links: [],
  });
  assert.equal(projectGraph(v, ["alpha"], NEVER_BEHIND).meta.code, null);
});

test("the projection is cached until a graph file changes on disk", () => {
  const v = makeTmp();
  skill(v, "alpha");
  writeGraph(v, "graphify-out", {
    nodes: [node("a1", "alpha/SKILL.md")],
    links: [],
  });
  const first = readVaultGraph(v, ["alpha"], NEVER_BEHIND);
  assert.equal(readVaultGraph(v, ["alpha"], NEVER_BEHIND), first);
  writeGraph(v, "graphify-out", {
    nodes: [node("a1", "alpha/SKILL.md"), node("a2", "alpha/SKILL.md")],
    links: [],
  });
  const second = readVaultGraph(v, ["alpha"], NEVER_BEHIND);
  assert.notEqual(second, first);
  assert.equal(second.meta.nodes, 2);
});

test("cross proposals that never made the graph are surfaced for review", () => {
  const v = makeTmp();
  skill(v, "personal-brand-system");
  skill(v, "wedding-brand-system");
  skill(v, "content-engine");
  writeGraph(v, "graphify-out", {
    nodes: [
      node("p1", "personal-brand-system/SKILL.md"),
      node("w1", "wedding-brand-system/SKILL.md"),
      node("c1", "content-engine/SKILL.md"),
    ],
    // Questa coppia e' gia' servita nel grafo: non e' una proposta in attesa.
    links: [{ source: "p1", target: "w1", relation: "hands-off-to" }],
  });
  mkdirSync(path.join(v, "graphify-out"), { recursive: true });
  writeFileSync(
    path.join(v, "graphify-out", ".graphify_cross.json"),
    JSON.stringify({
      edges: [
        {
          a: "personal-brand-system",
          b: "wedding-brand-system",
          relation: "hands-off-to",
          evidence: "gia servita",
          confidence_score: 0.8,
        },
        {
          a: "personal-brand-system",
          b: "content-engine",
          relation: "hands-off-to",
          evidence: "Carica la Brand System del cappello",
          confidence_score: 0.65,
        },
        {
          a: "personal-brand-system",
          b: "skill-sparita",
          relation: "references",
          evidence: "x",
          confidence_score: 0.9,
        },
      ],
    }),
  );
  const g = projectGraph(
    v,
    ["personal-brand-system", "wedding-brand-system", "content-engine"],
    NEVER_BEHIND,
  );
  assert.deepEqual(
    g.weakCross.map((w) => [w.a, w.b, w.score]),
    [["personal-brand-system", "content-engine", 0.65]],
  );
  assert.equal(g.weakCross[0].evidence, "Carica la Brand System del cappello");
});

test("a vault with no cross layer simply has no proposals", () => {
  const v = makeTmp();
  skill(v, "alpha");
  writeGraph(v, "graphify-out", {
    nodes: [node("a1", "alpha/SKILL.md")],
    links: [],
  });
  assert.deepEqual(projectGraph(v, ["alpha"], NEVER_BEHIND).weakCross, []);
});
