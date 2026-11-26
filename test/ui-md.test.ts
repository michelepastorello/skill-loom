import { test } from "node:test";
import assert from "node:assert/strict";
import { loadUiFns } from "./ui-harness.js";

// renderMd() is the markdown renderer behind the document viewer. These tests
// cover the block-structure rules, not styling: a viewer over a skill vault
// must not silently change what a document says.

type Render = (
  src: string,
  showFm?: boolean,
  fmFile?: string,
  humanTitle?: string,
) => string;

function md(): Render {
  const ctx = loadUiFns(
    ["esc", "slugify", "linkifyBareUrls", "colorSw", "emojiIcons", "renderMd"],
    {
      // never reached: no test uses a fenced block or frontmatter
      LANG_BY_FENCE: {},
      highlight: (code: string) => code,
      renderFrontmatterCard: () => "",
      // the real catalog lives in icons.js; the name is what matters here
      iconInner: (nm: string) => `<!--${nm}-->`,
    },
  );
  return (src, showFm = false, fmFile = "", humanTitle = "") =>
    (ctx.renderMd as Render)(src, showFm, fmFile, humanTitle);
}

// --- ordered lists ----------------------------------------------------------

test("renderMd: a sub-list does not restart the parent <ol> numbering", () => {
  const html = md()(
    "1. uno\n2. due\n3. tre:\n   - alpha\n   - beta\n4. quattro\n5. cinque\n",
  );
  // one <ol> holding all five steps, with the sub-list nested inside step 3
  assert.equal(html.match(/<ol>/g)?.length, 1);
  assert.match(html, /<li>tre:<ul><li>alpha<\/li><li>beta<\/li><\/ul><\/li>/);
  assert.match(html, /<li>quattro<\/li><li>cinque<\/li><\/ol>/);
  assert.doesNotMatch(html, /start=/);
});

test("renderMd: a blank line between steps keeps one list", () => {
  const html = md()("1. uno\n\n2. due\n\n3. tre\n");
  assert.equal(html.match(/<ol>/g)?.length, 1);
  assert.equal(html.match(/<li>/g)?.length, 3);
});

test("renderMd: a list that starts at n carries start=n", () => {
  assert.match(md()("3. tre\n4. quattro\n"), /^<ol start="3">/);
});

test("renderMd: a blank line followed by prose ends the list", () => {
  const html = md()("- uno\n- due\n\ntesto normale\n");
  assert.match(html, /<\/ul><p>testo normale<\/p>$/);
});

// --- nested unordered lists -------------------------------------------------

test("renderMd: indentation nests instead of flattening", () => {
  const html = md()("- livello 1\n  - livello 2\n    - livello 3\n");
  assert.equal(
    html,
    "<ul><li>livello 1<ul><li>livello 2<ul><li>livello 3</li></ul></li></ul></li></ul>",
  );
});

test("renderMd: a tab indents like four spaces", () => {
  assert.equal(
    md()("- padre\n\t- figlio\n"),
    "<ul><li>padre<ul><li>figlio</li></ul></li></ul>",
  );
});

test("renderMd: siblings of different type become sibling lists", () => {
  const html = md()("- bullet\n1. numero\n");
  assert.equal(html, "<ul><li>bullet</li></ul><ol><li>numero</li></ol>");
});

test("renderMd: task items keep their checkbox class at any depth", () => {
  const html = md()("- [x] fatto\n  - [ ] annidato\n");
  assert.match(html, /<li class="task done">fatto/);
  assert.match(html, /<li class="task">annidato<\/li>/);
});

// --- blockquotes ------------------------------------------------------------

test("renderMd: a multi-line quote is one blockquote", () => {
  assert.equal(
    md()("> riga uno\n> riga due\n> riga tre\n"),
    "<blockquote><p>riga uno riga due riga tre</p></blockquote>",
  );
});

test("renderMd: a bare > splits paragraphs inside one blockquote", () => {
  const html = md()("> primo\n>\n> secondo\n");
  assert.equal(html, "<blockquote><p>primo</p><p>secondo</p></blockquote>");
});

// --- tables -----------------------------------------------------------------

test("renderMd: an escaped pipe stays inside its cell", () => {
  const html = md()(
    '| chiave | valore |\n| --- | --- |\n| comando | `ifconfig \\| grep "inet"` dà un IP |\n',
  );
  assert.equal(html.match(/<td>/g)?.length, 2);
  assert.match(
    html,
    /<code>ifconfig \| grep &quot;inet&quot;<\/code> dà un IP/,
  );
});

test("renderMd: an unescaped pipe still separates columns", () => {
  const html = md()("| a | b |\n| --- | --- |\n| uno | due |\n");
  assert.equal(html.match(/<td>/g)?.length, 2);
  assert.match(html, /<td>uno<\/td><td>due<\/td>/);
});

// --- status glyphs ----------------------------------------------------------

test("renderMd: a status emoji becomes a tinted Lucide glyph", () => {
  const html = md()("⚠️ vedi avvertenza sotto\n");
  assert.match(html, /<span class="gly warn"><svg [^>]*fill="none"/);
  assert.match(html, /<!--triangle-alert-->/);
  assert.doesNotMatch(html, /⚠/);
  assert.doesNotMatch(html, /️/); // the variation selector goes with it
});

test("renderMd: a coloured circle is filled, not outlined", () => {
  const html = md()("- KR 🔴 in pressione\n");
  assert.match(html, /<span class="gly err"><svg [^>]*fill="currentColor"/);
  assert.match(html, /<!--circle-->/);
});

test("renderMd: an emoji inside a code span stays a character", () => {
  const html = md()("il marcatore `status: ⚠️` resta testo\n");
  assert.match(html, /<code>status: ⚠️<\/code>/);
});

test("renderMd: an unmapped emoji is left to the platform font", () => {
  assert.match(md()("festeggia 🎉 adesso\n"), /festeggia 🎉 adesso/);
});

// --- emphasis ---------------------------------------------------------------

test("renderMd: underscores emphasise at word boundaries", () => {
  const html = md()("qui c'è il _quando_ e i _footgun_.\n");
  assert.match(html, /il <em>quando<\/em> e i <em>footgun<\/em>\./);
});

test("renderMd: __double underscore__ is bold", () => {
  assert.match(
    md()("un __termine per volta__\n"),
    /<strong>termine per volta<\/strong>/,
  );
});

test("renderMd: snake_case identifiers stay literal", () => {
  for (const src of [
    "il campo replaced_by è valorizzato",
    "vedi test_gate_contract.py e test_graphify_refresh.py",
    "source_first_touch vs source_last_touch",
  ]) {
    const html = md()(src + "\n");
    assert.doesNotMatch(html, /<em>/, src);
    assert.doesNotMatch(html, /<strong>/, src);
  }
});

test("renderMd: an escaped underscore stays literal", () => {
  assert.doesNotMatch(md()("\\_non corsivo_\n"), /<em>/);
});

// --- default Markdown view --------------------------------------------------

test("defaultMarkdownView: raw HTML assets open as source", () => {
  const ctx = loadUiFns(["defaultMarkdownView"]);
  const choose = ctx.defaultMarkdownView as (
    path: string,
    content: string,
  ) => string;
  const skeleton = '---\ntitle: TITOLO\n---\n\n<div class="cover-page">\n';
  assert.equal(choose("assets/skeleton-editorial.md", skeleton), "source");
});

test("defaultMarkdownView: prose assets and references stay rendered", () => {
  const ctx = loadUiFns(["defaultMarkdownView"]);
  const choose = ctx.defaultMarkdownView as (
    path: string,
    content: string,
  ) => string;
  assert.equal(
    choose("assets/workshop-one-pager.md", "# Workshop\n\nTesto.\n"),
    "rendered",
  );
  assert.equal(
    choose("references/templates.md", "```html\n<div>esempio</div>\n```\n"),
    "rendered",
  );
});

// --- appearance -------------------------------------------------------------

test("nextTheme cycles system → light → dark → system", () => {
  const ctx = loadUiFns(["nextTheme"], { THEMES: ["system", "light", "dark"] });
  const next = ctx.nextTheme as (s: string) => string;
  assert.equal(next("system"), "light");
  assert.equal(next("light"), "dark");
  assert.equal(next("dark"), "system");
  // an unknown or missing stored value starts the cycle, never breaks it
  assert.equal(next("sepia"), "system");
});

// --- regressions on neighbouring blocks -------------------------------------

test("renderMd: a horizontal rule is not eaten by the list parser", () => {
  assert.match(md()("- uno\n\n---\n\ntesto\n"), /<\/ul><hr><p>testo<\/p>/);
});

test("renderMd: headings still get slug ids", () => {
  assert.match(md()("## Core — leggi prima\n"), /<h2 id="core-leggi-prima">/);
});

test("renderMd: a rating star renders filled and amber, not a hollow outline", () => {
  // ⭐ in vault documents is a rating mark ("★★★★ replicabilità PMI"). The
  // Lucide swap once used the outline star in --dim: a hollow grey star reads
  // as an EMPTY rating — the opposite of what the author wrote.
  const html = md()("**A1 — caso · ⭐⭐⭐ replicabilità.**\n");
  const stars = html.match(
    /<span class="gly warn"><svg[^>]*fill="currentColor"/g,
  );
  assert.equal(stars?.length, 3);
  assert.doesNotMatch(html, /gly dim"><svg[^>]*fill="none"[^>]*>[^<]*<polygon/);
});
