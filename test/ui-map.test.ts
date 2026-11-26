import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUiFns } from "./ui-harness.js";

const skills = [
  { name: "bottega19-ads-review", domain: "bottega19" },
  { name: "bottega19-brand-system", domain: "bottega19" },
  { name: "forpros-brand-system", domain: "forpros" },
  { name: "artifact-versioning", domain: "cross" },
  { name: "noteplan", domain: "personal" },
];

function labelCtx() {
  const ctx = loadUiFns(["famOf", "mapLabels"], {
    axisList: () => [{ id: "domain", label: "Domain" }],
  });
  ctx.state = { skills };
  return ctx.mapLabels as (names: string[]) => Record<string, string>;
}

test("a label drops the taxonomy value the vault names its skills after", () => {
  const labels = labelCtx()(skills.map((s) => s.name));
  assert.equal(labels["bottega19-ads-review"], "ads-review");
  // "artifact" is the family, not the domain: stripping it would leave
  // "versioning" and lose the subject.
  assert.match(labels["artifact-versioning"], /^artifact-/);
  assert.equal(labels["noteplan"], "noteplan");
});

test("a label keeps its prefix when stripping would collide", () => {
  const labels = labelCtx()(skills.map((s) => s.name));
  // Both keep their prefix (and are truncated at the label cap), instead of
  // both reading "brand-system".
  assert.match(labels["bottega19-brand-system"], /^bottega19-/);
  assert.match(labels["forpros-brand-system"], /^forpros-/);
});

test("a long label is truncated, so the grid cell holds it", () => {
  const ctx = loadUiFns(["famOf", "mapLabels"], { axisList: () => [] });
  ctx.state = { skills: [{ name: "naming-positioning-decision-room" }] };
  const labels = (ctx.mapLabels as (n: string[]) => Record<string, string>)([
    "naming-positioning-decision-room",
  ]);
  assert.equal(labels["naming-positioning-decision-room"].length, 14);
  assert.match(labels["naming-positioning-decision-room"], /…$/);
});

function layoutCtx() {
  const ctx = loadUiFns(["mapField", "mapSingleField", "mapLayout"], {
    MAP_CELL: 74,
    MAP_ROWH: 84,
    MAP_PADX: 14,
    MAP_HEAD: 26,
    MAP_GAP: 16,
  });
  return ctx.mapLayout as (
    groups: { key: string; label: string; items: { name: string }[] }[],
    width: number,
  ) => Layout;
}

interface Box {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: { name: string }[];
  pos: Record<string, { x: number; y: number }>;
}
interface Layout {
  boxes: Box[];
  height: number;
}

const group = (key: string, n: number) => ({
  key,
  label: key,
  items: Array.from({ length: n }, (_, i) => ({ name: `${key}-${i}` })),
});

test("the layout is deterministic: same input, same coordinates", () => {
  const layout = layoutCtx();
  const groups = [group("alpha", 5), group("beta", 3)];
  const a = layout(groups, 1200);
  const b = layout(groups, 1200);
  assert.deepEqual(a, b);
});

test("every skill gets a position inside its own field", () => {
  const layout = layoutCtx();
  const { boxes } = layout([group("alpha", 7)], 1200);
  const box = boxes[0];
  assert.equal(Object.keys(box.pos).length, 7);
  for (const p of Object.values(box.pos)) {
    assert.ok(p.x > box.x && p.x < box.x + box.w, "x inside the field");
    assert.ok(p.y > box.y && p.y < box.y + box.h, "y inside the field");
  }
});

test("one group takes the width it is given instead of a narrow column", () => {
  const layout = layoutCtx();
  const wide = layout([group("all", 24)], 1400);
  const narrow = layout([group("all", 24)], 700);
  assert.ok(wide.boxes[0].w > narrow.boxes[0].w, "the field uses the canvas");
  assert.ok(wide.boxes[0].w <= 1400, "and never exceeds it");
  assert.ok(wide.height < narrow.height, "so it needs fewer rows");
});

test("fields wrap to a new row instead of overflowing the canvas", () => {
  const layout = layoutCtx();
  const groups = [group("a", 6), group("b", 6), group("c", 6)];
  const wide = layout(groups, 2000);
  const narrow = layout(groups, 700);
  assert.equal(new Set(wide.boxes.map((b) => b.y)).size, 1);
  assert.ok(new Set(narrow.boxes.map((b) => b.y)).size > 1);
  assert.ok(narrow.height > wide.height);
  for (const b of narrow.boxes) assert.ok(b.x + b.w <= 700, "field fits");
});

// The shelf packing this replaced made every row as tall as its tallest field,
// so a 3-skill field beside a 9-skill one carried a field of nothing under it:
// on the real vault 42% of the canvas was empty. These four tests hold the
// property that fixed it.
test("a field sits directly under the one above it, never over a hole", () => {
  const layout = layoutCtx();
  const { boxes } = layout(
    [group("a", 14), group("b", 2), group("c", 9), group("d", 1)],
    924,
  );
  const byColumn = new Map<number, Box[]>();
  for (const b of boxes) byColumn.set(b.x, [...(byColumn.get(b.x) ?? []), b]);
  for (const column of byColumn.values()) {
    column.sort((p, q) => p.y - q.y);
    let top = 16; // MAP_GAP: the first field starts at the canvas margin
    for (const b of column) {
      assert.equal(b.y, top, `no gap above ${b.key}`);
      top = b.y + b.h + 16;
    }
  }
});

test("the canvas ends with its tallest column, nothing below", () => {
  const layout = layoutCtx();
  const { boxes, height } = layout(
    [group("a", 14), group("b", 2), group("c", 9), group("d", 1)],
    924,
  );
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  assert.equal(height, bottom + 16);
});

test("the biggest group is placed first, so the columns close level", () => {
  const layout = layoutCtx();
  const groups = [group("small", 1), group("big", 14), group("mid", 6)];
  const { boxes } = layout(groups, 924);
  // join(): the boxes come back from the vm realm, so their array is not
  // reference-equal to one built here.
  assert.equal(boxes.map((b) => b.key).join(" "), "big mid small");
});

test("a row that does not fill the grid is centred inside its field", () => {
  const layout = layoutCtx();
  // 3 columns at this width: the second row holds one node, and a lone node
  // belongs in the middle of the field, not in its top-left corner.
  const { boxes } = layout([group("a", 4), group("b", 1)], 924);
  const four = boxes.find((b) => b.key === "a") as Box;
  assert.equal(four.pos["a-3"].x, four.x + four.w / 2);
  const one = boxes.find((b) => b.key === "b") as Box;
  assert.equal(one.pos["b-0"].x, one.x + one.w / 2);
});

test("fields share one column width, so the map reads as a grid", () => {
  const layout = layoutCtx();
  const { boxes } = layout([group("a", 14), group("b", 2), group("c", 9)], 924);
  assert.equal(new Set(boxes.map((b) => b.w)).size, 1);
});

function focusCtx(over: Record<string, unknown> = {}) {
  const edges = [
    { a: "alpha", b: "beta", weight: 4, relations: {}, samples: [] },
  ];
  const ctx = loadUiFns(["famOf", "mapFocus"], {
    searchQ: "",
    mapLens: null,
    graphData: {
      skills: {
        alpha: {
          concept: 3,
          dupes: [["a", "b"]],
          code: { nodes: 2, files: [] },
        },
        beta: { concept: 1, dupes: [] },
        gamma: { concept: 2, dupes: [] },
      },
      edges,
      mentions: [],
    },
    mapEdges: () => edges,
    ...over,
  });
  return ctx;
}

test("no lens and no search leaves everything at full strength", () => {
  const ctx = focusCtx();
  const focus = (ctx.mapFocus as (n: string[]) => Set<string> | null)([
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.equal(focus, null);
});

test("each lens answers its own question", () => {
  const names = ["alpha", "beta", "gamma"];
  const run = (lens: string) => {
    const ctx = focusCtx({ mapLens: lens });
    return [
      ...((ctx.mapFocus as (n: string[]) => Set<string>)(names) ?? []),
    ].sort();
  };
  assert.deepEqual(run("coupled"), ["alpha", "beta"]);
  assert.deepEqual(run("unlinked"), ["gamma"]);
  assert.deepEqual(run("dupes"), ["alpha"]);
  assert.deepEqual(run("code"), ["alpha"]);
});

test("search wins over the lens, so typing always narrows what you see", () => {
  const ctx = focusCtx({ searchQ: "gam", mapLens: "coupled" });
  const focus = (ctx.mapFocus as (n: string[]) => Set<string>)([
    "alpha",
    "beta",
    "gamma",
  ]);
  assert.deepEqual([...focus], ["gamma"]);
});
