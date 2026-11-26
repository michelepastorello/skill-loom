import { test } from "node:test";
import assert from "node:assert/strict";
import {
  words,
  headings,
  tables,
  extractProtected,
  baselineFingerprint,
  isAccepted,
  findStaleAcceptance,
} from "../src/loss.js";
import type { LossAcceptance } from "../src/config.js";

test("words tokenizes numbers and percentages", () => {
  const w = words("Spend €1.200 to gain 30% in 3 settimane.");
  // `words` only has € in the CONTINUATION class, not the start class, so the
  // currency symbol is dropped here — capturing €amounts is extractProtected's
  // job, not words'. The numeric token survives.
  assert.ok(w.includes("1.200"));
  assert.ok(w.includes("30%"));
});

test("headings returns trimmed heading lines only", () => {
  assert.deepEqual(headings("# Title\ntext\n## Sub\n"), ["# Title", "## Sub"]);
});

test("tables detects a markdown table header row", () => {
  const md = "| a | b |\n| - | - |\n| 1 | 2 |\n";
  assert.equal(tables(md).length, 1);
});

test("extractProtected pulls structural categories", () => {
  // The code span must be a SINGLE token (the rule rejects `foo bar`), and the
  // currency amount must not butt against punctuation (the greedy number regex
  // would otherwise keep a trailing "." → element "€5.").
  const got = extractProtected(
    "Run `skill-loom` doctor, expect HTTP 200, GDPR applies, cost €5 today.",
    [],
  );
  assert.ok(got.includes("skill-loom")); // code span, single token
  assert.ok(got.includes("GDPR")); // ALL-CAPS acronym
  assert.ok(got.includes("€5")); // currency
});

test("extractProtected keeps a duration's internal space so coverage can match", () => {
  // Regression: normalizing "2 ore" -> "2ore" here made the token never match
  // its own unchanged text under termIsCovered's literal includes(), producing
  // a false "lost" on a clean tree.
  const got = extractProtected("I token OAuth scadono dopo 2 ore.", []);
  assert.ok(got.includes("2 ore")); // as it appears in text, not "2ore"
  assert.ok(!got.includes("2ore"));
  // and the token is genuinely present in unchanged text
  assert.ok("I token OAuth scadono dopo 2 ore.".includes("2 ore"));
});

test("extractProtected adds configured domain terms present in text", () => {
  const got = extractProtected("We use HogQL against PostHog daily.", [
    "HogQL",
    "PostHog",
    "Fondimpresa",
  ]);
  assert.ok(got.includes("HogQL"));
  assert.ok(got.includes("PostHog"));
  assert.ok(!got.includes("Fondimpresa")); // configured but absent from text
});

test("extractProtected hardcodes no domain vocabulary", () => {
  // A term the OLD loss-audit hardcoded must NOT appear unless configured.
  const got = extractProtected("Fondimpresa funds the course.", []);
  assert.ok(!got.includes("Fondimpresa"));
});

const OLD = "Fondimpresa funds the course.\n";
const FP = baselineFingerprint(OLD);

const acc: LossAcceptance[] = [
  {
    file: "a.md",
    term: "Fondimpresa",
    reason: "consolidated in financed-training",
    baseline: FP,
  },
];

test("isAccepted silences a matching (file, term) with a fresh baseline", () => {
  assert.equal(isAccepted("a.md", "Fondimpresa", FP, acc), true);
});

test("isAccepted does NOT silence a different term (new loss)", () => {
  assert.equal(isAccepted("a.md", "HogQL", FP, acc), false);
});

test("isAccepted does NOT silence when the baseline changed (stale)", () => {
  const staleFp = baselineFingerprint(
    "Fondimpresa now lives elsewhere entirely.\n",
  );
  assert.equal(isAccepted("a.md", "Fondimpresa", staleFp, acc), false);
});

test("isAccepted refuses a blank reason even if present in config", () => {
  const blank: LossAcceptance[] = [
    { file: "a.md", term: "Fondimpresa", reason: "   ", baseline: FP },
  ];
  assert.equal(isAccepted("a.md", "Fondimpresa", FP, blank), false);
});

test("findStaleAcceptance surfaces a (file,term) whose baseline no longer matches", () => {
  const staleFp = baselineFingerprint("changed\n");
  const hit = findStaleAcceptance("a.md", "Fondimpresa", staleFp, acc);
  assert.ok(hit);
  assert.equal(hit?.term, "Fondimpresa");
});
