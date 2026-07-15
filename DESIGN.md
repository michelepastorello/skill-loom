# DESIGN.md

The dashboard's visual system. `src/ui.html` is the single self-contained
implementation.

## Register + strategy

Product register (design serves the tool). Color strategy **Restrained**:
cool-tinted neutrals + one accent used on ≤10% of the surface. The tool is a
short-session governance surface; it should disappear into the task.

## Theme

Light-first, dark designed (not inverted), switched by `prefers-color-scheme`.
Scene: a solo operator doing a quick check on their skill vault, large monitor,
daylight or a dim room. Both themes are first-class.

## Color (OKLCH only, never #fff/#000 — WCAG-AA verified both themes)

Accent **teal ~205**. Chosen by color theory: the cool complement of the
warm-neutral field lands in a hue band the status semantics don't occupy, so the
accent never competes with meaning; distinct from a generic product blue and from
violet. Neutrals are cool blue-grey at low chroma (hue ~232 light, ~245 dark),
harmonized with the accent into one temperature family.

| Token   | Light                  | Dark                   |
| ------- | ---------------------- | ---------------------- |
| bg      | oklch(97.6% 0.006 232) | oklch(21% 0.012 245)   |
| surface | oklch(99.3% 0.003 232) | oklch(24.5% 0.014 245) |
| panel   | oklch(95% 0.008 232)   | oklch(28.5% 0.016 245) |
| line    | oklch(90.5% 0.011 232) | oklch(34% 0.016 245)   |
| fg      | oklch(26% 0.018 245)   | oklch(92% 0.01 240)    |
| dim     | oklch(50% 0.02 242)    | oklch(70% 0.014 240)   |
| accent  | oklch(48.5% 0.115 205) | oklch(78% 0.10 205)    |
| ok      | oklch(46% 0.13 160)    | oklch(72% 0.13 160)    |
| warn    | oklch(51.5% 0.115 68)  | oklch(76% 0.13 74)     |
| err     | oklch(52% 0.16 25)     | oklch(68% 0.15 25)     |

Semantic hue families (ok=green, warn=amber, err=red) are reserved for state;
the accent stays out of them. Soft variants = same hue at ~10-16% alpha.

**Taxonomy accents** (library scan): each domain/layer value carries a hue on the
section legend dot + group chip, so the grid scans by taxonomy at a glance without
touching data. The hue is rank-based over the axis's sorted values (`taxHueStyle`
in JS: 8-hue palette `TAX_HUES`, stride-3 so adjacent values sit far apart on the
wheel) — the palette stays clear of the state bands (green 160 / amber 68 /
red 25). Tokens `--tint` / `--tint-soft` carry it, at a fixed mid-lightness that
reads on both themes. The state badge on a card shows only when health deviates
(attention/inactive); an active skill shows no badge, so exceptions are the only
cards that light up.

**Skill tiles** (NotePlan model): each card/detail header carries a rounded tile.
Frontmatter `icon: <name>` picks a line-icon from an inline Lucide-style registry
(`ICONS` in `ui.html`); no `icon:` falls back to the skill's monogram. Optional
`icon-color: <family>-<step>` (Tailwind-ish token, e.g. `emerald-500`) sets the
tile hue for that one skill via `namedColor()` → fixed OKLCH (theme-independent,
like NotePlan); absent, the tile stays neutral. The vault is flat (no categories),
so tile colour is opt-in per skill, not derived from a folder.

## Typography

**Figtree** (humanist grotesk), self-hosted as a base64 `@font-face` — no external
assets. 15px base, line-height 1.55, letter-spacing -0.006em. Prose measure-capped
~74ch; tables and code use the full column. Monospace (`ui-monospace`) only for
identifiers, paths, hashes, code.

## Layout

Nav destinations: **My skills** (full-width category card grid), **Status** (the
merged housekeeping surface: unsaved changes + sync + link health), and **Config**.
Config is a settings console: a left rail of sections (Rules, Vault, Runtimes,
Naming, Sync) plus read-only Reference (CONVENTIONS.md, source-registry.yaml,
loom.json), with the selected section in the right pane. Sub-views: **Skill
detail** is a full-bleed three-pane (files · document · runtimes+history); **New
skill** and **Archived** are focused/bounded. Scrolling views vs
full-bleed fixed views (`body.fixed` for detail + status). Space is partitioned into
regions (main + rail) rather than left-stacked — no dead width.

## Components

Pill badges with inline SVG (state in words: "Active everywhere" / "Needs attention"
/ "Not active yet"). Runtime toggles (switch). Per-file change rows with inline diff
(not cards). Ruled tables for coverage/archive. Confirm dialog + dark toast. Every
write action shows its dry-run plan before it asks to confirm.

## Bans

Side-stripe accent borders, gradient text, hero-metric blocks, nested cards,
decorative motion, external font/style links, em dashes in UI copy.
