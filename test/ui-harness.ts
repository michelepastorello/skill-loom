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

// Return the full `function NAME(...) {...}` source by matching balanced braces.
// String- and comment-aware so braces inside "...", '...', // and /* */ don't
// throw off the depth count. It does NOT parse `${}` inside template literals,
// so only extract functions whose bodies use no template literals (the pure
// view-logic helpers we test don't).
export function extractFnSource(name: string): string {
  const start = uiScript.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in ui.js`);
  let i = uiScript.indexOf("{", start);
  if (i < 0) throw new Error(`no body found for function ${name}`);
  let depth = 0;
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  for (; i < uiScript.length; i++) {
    const c = uiScript[i];
    const prev = uiScript[i - 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && uiScript[i + 1] === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && uiScript[i + 1] === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && uiScript[i + 1] === "*") {
      inBlock = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return uiScript.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting function ${name}`);
}

export interface UiCtx {
  state: unknown;
  [fn: string]: unknown;
}

// Load the named ui.js functions into a fresh vm context. Free `state`
// references inside them resolve to `ctx.state`, so tests set `ctx.state = ...`
// before each call. Returns the context; call fns as `ctx.linkStateOf(...)`.
export function loadUiFns(names: string[]): UiCtx {
  const src = names.map(extractFnSource).join("\n\n");
  const ctx: UiCtx = { state: undefined };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}
