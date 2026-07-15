import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTmp } from "./helpers.js";
import { saveConfig, DEFAULT_IGNORE } from "../src/config.js";
import { collectDoctor, rulesImpact } from "../src/gate.js";

function skill(
  vault: string,
  name: string,
  opts: { desc: string; domain?: string; status?: string },
): void {
  const dir = path.join(vault, name);
  mkdirSync(dir, { recursive: true });
  const dom = opts.domain ? `domain: ${opts.domain}\n` : "";
  const st = opts.status ? `status: ${opts.status}\n` : "";
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${opts.desc}\n${dom}${st}---\n\n# ${name}\n`,
  );
}

test("rulesImpact reports skills newly flagged and newly passing", () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { descriptionMinChars: 3, allowedDomains: ["ok"] },
  });
  // passes today (desc 4 >= 3, domain ok); fails proposed (desc 4 < 10)
  skill(vault, "short-desc", { desc: "abcd", domain: "ok" });
  // fails today (domain "nope" not allowed); passes proposed (domain now allowed, desc long)
  skill(vault, "bad-domain", {
    desc: "a properly long description",
    domain: "nope",
  });

  const impact = rulesImpact(vault, {
    descriptionMinChars: 10,
    allowedDomains: ["ok", "nope"],
  });

  assert.deepEqual(
    impact.newlyFlagged.map((f) => f.name),
    ["short-desc"],
  );
  assert.match(impact.newlyFlagged[0].reason, /chars < 10/);
  assert.deepEqual(impact.nowPass, ["bad-domain"]);
  assert.equal(impact.currentFlagged, 1);
  assert.equal(impact.proposedFlagged, 1);
});

test("rulesImpact ignores non-active skills (they never block, matching the gate)", () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: {}, // nothing flagged today
  });
  skill(vault, "alive", { desc: "short" });
  skill(vault, "sleeping", { desc: "short", status: "suspended" });
  // A stricter min flags both via skillWarnings, but a suspended skill is
  // always advisory and never blocks, so it must not appear in the preview.
  const impact = rulesImpact(vault, { descriptionMinChars: 999 });
  const names = impact.newlyFlagged.map((f) => f.name);
  assert.ok(names.includes("alive"), "active skill is counted");
  assert.ok(!names.includes("sleeping"), "non-active skill must be excluded");
});

test("collectDoctor blocks a bad active skill but not a bad draft skill", () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { strict: true, descriptionMinChars: 20 },
  });
  const mk = (name: string, status: string) => {
    const d = path.join(vault, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, "SKILL.md"),
      `---\nname: ${name}\ndescription: short\nstatus: ${status}\n---\n\n# ${name}\n`,
    );
  };
  mk("livebad", "active"); // description "short" < 20 -> blocks (active + strict)
  mk("draftbad", "draft"); // same lint miss, but draft -> advisory, not blocking
  const rep = collectDoctor(vault);
  assert.ok(rep.blocking.some((b) => b.includes("livebad")));
  assert.ok(!rep.blocking.some((b) => b.includes("draftbad")));
});

test("collectDoctor blocks a config-level finding (invalid forbidBodyPatterns regex) under strict", () => {
  const vault = makeTmp();
  // Written directly via saveConfig, bypassing validateLint, to simulate a
  // hand-edited loom.json with a corrupt regex reaching disk.
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { strict: true, forbidBodyPatterns: ["[invalid("] },
  });
  skill(vault, "some-skill", { desc: "a perfectly fine description" });
  const rep = collectDoctor(vault);
  assert.ok(
    rep.blocking.some((b) => /lint config|invalid forbidBodyPatterns/.test(b)),
  );
});

test("collectDoctor demotes findings to warnings when lint is not strict (#27)", () => {
  const vault = makeTmp();
  saveConfig(vault, {
    schema: 1,
    consumers: {},
    ignore: [...DEFAULT_IGNORE],
    names: {},
    lint: { descriptionMinChars: 50 }, // no strict → lenient
  });
  skill(vault, "sk", { desc: "short", status: "active" });
  const rep = collectDoctor(vault);
  assert.equal(rep.blocking.length, 0); // nothing blocks in lenient mode
  assert.ok(
    rep.warnings.length > 0,
    "the description finding surfaces as a warning",
  );
});
