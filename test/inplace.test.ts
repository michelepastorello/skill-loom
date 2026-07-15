import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isServed, setServed } from "../src/inplace.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "loom-ip-"));
}

test("setServed adds/removes a vault path in a nested array; isServed reflects it", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const vault = path.join(dir, "my-vault");
  writeFileSync(
    file,
    JSON.stringify({ skills: { load: { extraDirs: [] } }, other: 1 }, null, 2) +
      "\n",
  );
  const sv = { file, jsonPath: "skills.load.extraDirs" };

  assert.equal(isServed(vault, sv), false);
  assert.deepEqual(setServed(vault, sv, true), { changed: true });
  assert.equal(isServed(vault, sv), true);
  assert.deepEqual(setServed(vault, sv, true), { changed: false }); // idempotent

  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(obj.other, 1); // unrelated keys preserved
  assert.deepEqual(obj.skills.load.extraDirs, [path.resolve(vault)]);

  assert.deepEqual(setServed(vault, sv, false), { changed: true });
  assert.equal(isServed(vault, sv), false);
});

test("setServed creates the nested path on; no-op off when the file/array is absent", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const vault = path.join(dir, "v");
  writeFileSync(file, "{}\n");
  const sv = { file, jsonPath: "skills.load.extraDirs" };

  assert.deepEqual(setServed(vault, sv, false), { changed: false });
  assert.deepEqual(setServed(vault, sv, true), { changed: true });
  assert.equal(isServed(vault, sv), true);
  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(obj.skills.load.extraDirs, [path.resolve(vault)]);
});

test("setServed on an invalid-JSON file: off is a safe no-op, on throws clearly (#25)", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const vault = path.join(dir, "v");
  writeFileSync(file, "{ not valid json ");
  const sv = { file, jsonPath: "skills.load.extraDirs" };
  // Deactivating from a broken file must not blow up — there's nothing to remove.
  assert.deepEqual(setServed(vault, sv, false), { changed: false });
  // Activating into a broken file must fail with a clear error, not a raw parse.
  assert.throws(() => setServed(vault, sv, true), /is not a valid JSON object/);
});

test("setServed refuses to clobber a wrong-typed intermediate value on activate (#26)", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const vault = path.join(dir, "v");
  writeFileSync(file, JSON.stringify({ skills: { load: "oops" } }) + "\n");
  const sv = { file, jsonPath: "skills.load.extraDirs" };
  assert.throws(() => setServed(vault, sv, true), /is not an object/);
  // the hand-edited value survives — no silent overwrite, no write
  assert.equal(JSON.parse(readFileSync(file, "utf8")).skills.load, "oops");
});

test("setServed refuses to clobber a non-array leaf on activate (#26)", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const vault = path.join(dir, "v");
  writeFileSync(
    file,
    JSON.stringify({ skills: { load: { extraDirs: "nope" } } }) + "\n",
  );
  const sv = { file, jsonPath: "skills.load.extraDirs" };
  assert.throws(() => setServed(vault, sv, true), /is not an array/);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).skills.load.extraDirs,
    "nope",
  );
});
