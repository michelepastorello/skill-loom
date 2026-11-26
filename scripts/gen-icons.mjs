#!/usr/bin/env node
// Generate dist/src/icons.js from the pinned lucide-static catalog.
//
// Reads every icons/*.svg, extracts its inner markup, and writes a deterministic
// browser global (globalThis.SKILL_LOOM_ICONS = { "<kebab-name>": "<inner svg>" }).
// The dashboard's <svg> shell already matches Lucide's root attributes, so only
// the inner shapes are stored. Any anomaly (non-kebab filename, missing <svg>,
// empty body, suspiciously small catalog) fails the build, so a partial or
// malformed map never ships. Runs after `tsc`, before the ui.* copy.
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = path.join(repo, "node_modules", "lucide-static", "icons");
const outDir = path.join(repo, "dist", "src");
const outFile = path.join(outDir, "icons.js");

const die = (msg) => {
  console.error(`gen-icons: ${msg}`);
  process.exit(1);
};

if (!existsSync(iconsDir))
  die(`lucide-static icons not found at ${iconsDir} — run npm install`);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const catalog = {};

for (const file of readdirSync(iconsDir)) {
  if (!file.endsWith(".svg")) continue;
  const name = file.slice(0, -4);
  if (!KEBAB.test(name)) die(`non-kebab icon filename: ${file}`);
  if (name in catalog) die(`duplicate icon key: ${name}`);
  const raw = readFileSync(path.join(iconsDir, file), "utf8");
  const m = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  if (!m) die(`no <svg> root in ${file}`);
  const inner = m[1].replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();
  if (!inner) die(`empty icon body in ${file}`);
  catalog[name] = inner;
}

const names = Object.keys(catalog).sort();
if (names.length < 1000)
  die(`only ${names.length} icons — suspiciously small, aborting`);

// Sorted keys + JSON.stringify escaping => identical input yields identical bytes.
const body = names
  .map((n) => `${JSON.stringify(n)}:${JSON.stringify(catalog[n])}`)
  .join(",");
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `globalThis.SKILL_LOOM_ICONS = {${body}};\n`, "utf8");
console.log(
  `gen-icons: wrote ${names.length} icons to ${path.relative(repo, outFile)}`,
);
