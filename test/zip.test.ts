import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, zip } from "../src/zip.js";

// The reference value for "123456789" from the CRC-32 spec: if the table or
// the bit order ever drifts, every archive this writer produces is refused by
// every extractor, and nothing else in the file would say so.
test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("zip writes the signatures and counts the entries", () => {
  const buf = zip([
    { path: "a/SKILL.md", data: Buffer.from("# hello\n") },
    { path: "a/references/x.md", data: Buffer.from("x") },
  ]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // first local header
  // The end record is the last 22 bytes when there is no archive comment.
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  assert.equal(buf.readUInt16LE(end + 10), 2); // entries in the directory
});

test("zip stores rather than grows an incompressible entry", () => {
  // Real random bytes: deflate cannot beat them and returns more than it was
  // given, so the writer has to fall back to storing or every image in a
  // skill's references leaves the archive bigger than it went in. (An
  // arithmetic "noise" sequence is not enough — deflate finds the pattern.)
  const noise = randomBytes(4096);
  const buf = zip([{ path: "n.bin", data: noise }]);
  assert.equal(buf.readUInt16LE(8), 0); // method 0 = stored
  assert.ok(buf.length < noise.length + 200);
});

test("zip compresses what compresses", () => {
  const text = Buffer.from("skill-loom ".repeat(500));
  const buf = zip([{ path: "t.md", data: text }]);
  assert.equal(buf.readUInt16LE(8), 8); // method 8 = deflate
  assert.ok(buf.length < text.length / 2);
});

// The point of the whole file: a real extractor has to accept it. `unzip -t`
// verifies the CRCs and the directory, which is exactly what a hand-written
// container gets wrong.
test("unzip accepts the archive and restores the bytes", (t) => {
  let has = true;
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
  } catch {
    has = false;
  }
  if (!has) return t.skip("unzip is not installed");
  const dir = mkdtempSync(path.join(tmpdir(), "loom-zip-"));
  const file = path.join(dir, "out.zip");
  const body = "# hello\n\nunicode: caffè — ok\n";
  writeFileSync(
    file,
    zip([
      { path: "skill/SKILL.md", data: Buffer.from(body) },
      { path: "skill/references/deep/note.md", data: Buffer.from("nested") },
    ]),
  );
  execFileSync("unzip", ["-t", file], { stdio: "ignore" });
  const out = execFileSync("unzip", ["-p", file, "skill/SKILL.md"]);
  assert.equal(out.toString("utf8"), body);
});
