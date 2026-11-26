import { readFileSync } from "node:fs";
import vm from "node:vm";

// The UI's client script (src/ui.js) is a classic browser script — top-level
// DOM access, no module exports — so it can't be imported. This harness lifts
// individual top-level `function NAME(...) {...}` sources out of it and runs
// them in a vm context with an injectable `state` global, so pure view-logic
// helpers can be unit-tested with no browser, no jsdom, and no dependency.
const uiScript = readFileSync(
  new URL("../../src/ui.js", import.meta.url),
  "utf8",
);

// Return the full `function NAME(...) {...}` source, from the declaration to
// the closing brace in column 0.
//
// The earlier version counted braces while tracking strings and comments, but
// a hand-rolled scanner cannot tell a regex literal from a division operator:
// renderMd's inline() holds /`([^`]+)`/g, whose backticks were read as a
// template literal and swallowed the rest of the function. src/ui.js is
// prettier-formatted, so every top-level function ends at a lone `}` at the
// start of a line and nothing nested ever does — that is the reliable rule
// here, and it is immune to strings, comments, escapes and regexes alike.
export function extractFnSource(name: string): string {
  const decl = `function ${name}(`;
  const start = uiScript.indexOf(decl);
  if (start < 0) throw new Error(`function ${name} not found in ui.js`);
  if (start > 0 && uiScript[start - 1] !== "\n")
    throw new Error(`function ${name} is not top-level in ui.js`);
  const end = uiScript.indexOf("\n}\n", start);
  if (end < 0) throw new Error(`no closing brace found for function ${name}`);
  return uiScript.slice(start, end + 3);
}

export interface UiCtx {
  state: unknown;
  [fn: string]: unknown;
}

// Load the named ui.js functions into a fresh vm context. Free `state`
// references inside them resolve to `ctx.state`, so tests set `ctx.state = ...`
// before each call. Returns the context; call fns as `ctx.linkStateOf(...)`.
// `seed` pre-populates the context with values the extracted functions
// reference but that aren't `function` declarations (module-level consts) or
// that pull in machinery a unit test doesn't exercise (syntax highlighting).
export function loadUiFns(
  names: string[],
  seed: Record<string, unknown> = {},
): UiCtx {
  const src = names.map(extractFnSource).join("\n\n");
  const ctx: UiCtx = { state: undefined, ...seed };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
