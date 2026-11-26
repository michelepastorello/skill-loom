# DESIGN.md

The dashboard's visual system. `src/ui.html` is the single self-contained
implementation.

## Register + strategy

Product register (design serves the tool). Color strategy **Restrained**:
cool-tinted neutrals + one accent used on ≤10% of the surface. The tool is a
short-session governance surface; it should disappear into the task.

## Theme

Light-first, dark designed (not inverted). Scene: a solo operator doing a quick
check on their skill vault, large monitor, daylight or a dim room. Both themes
are first-class.

Every colour token carries both forms in a single `light-dark()` declaration, so
there is no duplicated dark block to keep in sync, and the active form follows
`color-scheme` on `:root`. The header carries a three-state control (System /
Light / Dark) that cycles on click and shows the current state as its icon;
`system` removes `data-theme` entirely, so the OS preference resumes rather than
being frozen into an explicit value. The choice persists in `localStorage`
(`skill-loom:theme`), and a storage failure degrades to the OS preference
instead of breaking the toggle.

## Color (OKLCH only, never #fff/#000 — WCAG-AA verified both themes)

Accent **teal ~205**. Chosen by color theory: the cool complement of the
warm-neutral field lands in a hue band the status semantics don't occupy, so the
accent never competes with meaning; distinct from a generic product blue and from
violet. Neutrals are cool blue-grey at low chroma (hue ~232 light, ~245 dark),
harmonized with the accent into one temperature family.

| Token  | Light                  | Dark                   | Role                  |
| ------ | ---------------------- | ---------------------- | --------------------- |
| shell  | oklch(94.2% 0.009 232) | oklch(21.5% 0.012 245) | library chrome        |
| bg     | oklch(95.9% 0.007 232) | oklch(21.5% 0.012 245) | canvas                |
| pane   | oklch(98% 0.005 232)   | oklch(24.5% 0.014 245) | content plane         |
| raised | oklch(98% 0.005 232)   | oklch(24.5% 0.014 245) | on top of a plane     |
| hover  | `--fg` at 5%           | `--fg` at 5%           | pointer feedback      |
| panel  | oklch(92.6% 0.01 232)  | oklch(28% 0.016 245)   | inset (tracks, bands) |
| line   | oklch(88.4% 0.013 232) | oklch(33% 0.016 245)   | border                |
| hair   | oklch(91.6% 0.011 232) | oklch(29.5% 0.014 245) | row rule              |
| fg     | oklch(26% 0.018 245)   | oklch(92% 0.01 240)    | headings, bold        |
| prose  | oklch(33% 0.018 245)   | oklch(76% 0.013 240)   | body                  |
| dim    | oklch(50% 0.02 242)    | oklch(70% 0.014 240)   | secondary             |
| faint  | oklch(57.5% 0.017 240) | oklch(65.5% 0.015 240) | quiet tier (see note) |
| accent | oklch(48.5% 0.115 205) | oklch(78% 0.10 205)    | selection, primary    |
| ok     | oklch(46% 0.13 160)    | oklch(72% 0.13 160)    | state                 |
| warn   | oklch(51.5% 0.115 68)  | oklch(76% 0.13 74)     | state                 |
| err    | oklch(52% 0.16 25)     | oklch(68% 0.15 25)     | state                 |

**Elevation.** `--shell` (library chrome), `--bg` (canvas), `--pane` (content
plane), `--raised` (what sits on a plane: buttons, fields, cards, dialogs), with
`--panel` the inset below all of them (segmented-control tracks, table header
bands, document blocks) and `--hover` for pointer feedback.

`--pane` and `--raised` hold the same value and are two tokens on purpose: one
names the plane a view's content sits on, the other what sits on top of it. A
single token for both meant a calibration of the panes silently moved every
button — and it is how Status' rail changed colour without anyone deciding it
should. `--hover` is `--fg` at 5% rather than a fixed grey, so it reads the same
on a pane at 98% and on a rail at 94.2%.

In dark, `--shell` equals `--bg` deliberately. The library rails read as
recessed because the content beside them rises, not because they sink; a darker
value was tried and made them look like a separate, heavier application. The
token earns its place in light, where the two genuinely differ.

Which plane a region takes depends on what the middle of the screen is:

- **The library** lifts the content: the pane is `--pane`, while the filter
  sidebar and the source band recede to `--shell`. A table wants to be the lit
  object, and those two are chrome wrapped around it. They are the only users of
  `--shell`.
- **The detail view inverts it**: the two sidebars take `--pane` and the
  document column stays on the canvas. A long read is calmer as the darkest
  thing on a dark screen, and the rails framing it are furniture, not subject.
- **Status** follows the detail: its rail takes `--pane`, so the right-hand
  rail does not change colour when you move between the two.
- **Config** keeps its nav on the canvas (`--bg`), a step below its pane.
- **The top bar always takes `--pane`**: it reads as the head of the pane,
  not as another sidebar.

Elevation does not mirror with the theme — "up" is lighter in both. What
mirrors is where the canvas sits on the scale. Before `--shell` existed, rails
and cards shared `--pane`, so in light the rails were the brightest thing on
screen and nothing read as layered; the flaw was in both themes, dark just hid
it better because its steps are twice as wide.

**The quiet tier is AA in dark and knowingly short in light.** `--faint` carries
counts, dates, paths and placeholders — 55 call sites, all of them informative
text, so 4.5:1 applies. In dark it sits at 65.5%, the floor that clears every
background it lands on (5.12 on `--pane`, 5.53 on `--shell`, 4.60 on `--panel`)
while staying a visible step below `--dim` at 70%.

Light cannot do both. Its backgrounds run 92.6-98%, packed against white, so the
usable range under `--dim` is compressed: the value that clears 4.5 everywhere
is 51%, one point off `--dim` at 50%. The tier would stop existing. Light
therefore keeps 57.5% and measures 4.12 / 3.68 / 3.51 — a recorded exception,
not an oversight. Two ways out if it ever matters: move `--faint` to 51% and
accept that light has one muted level instead of two, or open up the light ramp
so there is room beneath `--dim`.

Semantic hue families (ok=green, warn=amber, err=red) are reserved for state;
the accent stays out of them. Soft variants = same hue at ~10-16% alpha.

**Taxonomy accents** (library scan): the vault declares its own taxonomy axes
(a `taxonomy` block in `loom.json`, `resolveAxes()`, one axis id per group-by
button and filter section) — this is no longer a fixed `domain`/`layer` pair,
it is whatever the vault's config says, in declaration order. Each value on
each axis carries a hue on the section legend dot + group chip, so the grid
scans by taxonomy at a glance without touching data. The hue is rank-based
over the axis's sorted values (`taxHueStyle` in JS: 16-hue palette `TAX_HUES`,
stride-3 so adjacent values sit far apart on the wheel) — the palette stays
clear of the state bands (green 160 / amber 68 / red 25). **The stride must
stay coprime with the palette length**: `gcd(stride, length)` has to equal 1,
or the palette collapses onto a fraction of its hues — stride 3 against a
12-entry palette visits only 4 of them before repeating. A test pins
`gcd(3, 16) === 1`; if the palette is ever "tidied" to a different length,
that length must stay coprime with the stride or the collision comes back
silently (colors still render, they just stop being distinct). Tokens
`--tint` / `--tint-soft` carry it, at a fixed mid-lightness that reads on both
themes. The state badge on a card shows only when health deviates
(attention/inactive); an active skill shows no badge, so exceptions are the
only cards that light up.

The ledger table shows a single **Taxonomy** column — one chip per axis, not
one column per axis. Three declared axes plus a description do not fit the
table's width; a column per axis either truncates every one of them or pushes
the table into horizontal scroll on every row. The column holds a chip for
each axis you are _not_ currently grouped on (`orthAxesOf()` — the group-by
axis is already the section header, repeating it as a chip would be
redundant); with a single declared axis and grouping on, there is nothing
left to show and the column is omitted entirely.

**Skill tiles** (NotePlan model): each card/detail header carries a rounded tile.
Frontmatter `icon: <name>` picks a line-icon from an inline Lucide-style registry
(`ICONS` in `ui.html`); no `icon:` falls back to the skill's monogram. Optional
`icon-color: <family>-<step>` (Tailwind-ish token, e.g. `emerald-500`) sets the
tile hue for that one skill via `namedColor()` → fixed OKLCH (theme-independent,
like NotePlan); absent, the tile stays neutral. The vault is flat (no categories),
so tile colour is opt-in per skill, not derived from a folder.

## Typography

**Figtree** (humanist grotesk, variable 400-700), self-hosted as a base64
`@font-face` — no external assets. Emoji families are placed ahead of `system-ui`
in `--font`: SF Pro and Segoe UI carry monochrome glyphs for ⚠ ✅ ❌ and would
otherwise win the fallback. 15px base, line-height 1.55, letter-spacing -0.006em.
Monospace (`ui-monospace`) only for identifiers, paths, hashes, code.

**Document viewer scale**: h1 24 / h2 19 / h3 16 / h4 15 against a 15px body,
ratio ~1.2 and monotonic. Inline `strong` stays at 650: in dark, `--prose` (76%)
and `--prose-b` (86.5%) sit close enough that the weight carries most of the
bold/body distinction, and the headings win on size rather than needing it
lowered. One shared measure (`--measure: 100%` on `.doc`): prose, tables,
code blocks and dividers all take the full document column and share the same
right edge. No reading-width cap — the three-pane grid already bounds the column,
and a cap on top of it only adds dead width. A markdown table is a block, not
more prose: border, radius and a header band, so it stays legible as an object
while scrolling a long document.

**One fill for every document block.** `table`, `pre`, `blockquote` and inline
`code` all take `--panel` at 60%; the table's header band is the single step
beyond, at full `--panel`. Two values, no more. The direction matters as much as
the strength: `--panel` recedes in light and lifts in dark, so blocks stay
consistent _within_ a theme. A `--pane` fill (which lifts in light) put a
visible step between a table and the code block next to it. That split is the
system-wide rule — **`--panel` is the recessed material** (segmented-control
tracks, header bands, document blocks), **`--pane` is the raised one**
(buttons, cards, the active segment).
No vertical rules between columns (`table.grid` has none either; the header band
and the row rules carry the structure) and no hover state: a rendered document
is not interactive, and a row highlight suggests it is.

## Layout

Nav destinations: **My skills** (full-width category card grid), **Status** (the
merged housekeeping surface: unsaved changes + sync + link health), and **Config**.
Config is a settings console: a left rail of sections (Rules, Vault, Runtimes,
Naming, Sync) plus read-only Reference (CONVENTIONS.md, source-registry.yaml,
loom.json), with the selected section in the right pane. Sub-views: **Skill
detail** is a full-bleed three-pane (files · document · runtimes+history); **New
skill** and **Archived** are focused/bounded.

Crossing between the two sets closes the view, in both directions: the archive
is what comes after the library, so the way across sits after the rows rather
than competing with the actions in the header. The map is the one place it
cannot — two screens of canvas put the link somewhere nobody will scroll to —
so there it is not drawn at all, and the `a` shortcut is the way across.

The archive is the library over a different set, and only the controls that
survive the swap come with it. An archived skill is served by no runtime and
carries no git state of its own, so the Links and Sync facets and their two
columns are gone rather than filled with a default that reads as a
measurement; extraction skips `.archive`, so the map is not offered at all
(a mode that can only render an explanation is a dead end, not a mode — the
mode is remembered on the way in and restored on the way out, unless you
picked another one while you were there); and an axis the set does not carry
is dropped from Group by, from the rail and from the ledger, headings
included. Rail filters reset across the swap: a value one set does not hold
would empty the other from a control that no longer lists it.

**How the library is read is a standing preference**, not a per-visit choice: a
vault is read the same way every time it is opened, and re-picking the mode,
the axis and the filter was the first thing done in every session. The grouping
axis, the mode (grid / table / map) and the status filter all persist in
`localStorage`, keyed per source — each source declares its own axes and holds
its own statuses, and a source read as a table is not the one read as a map.
Only a choice the user made is written: the archive's fallbacks (no grouping,
since it carries one axis of the three; no map, since extraction skips it; no
status filter, since its statuses are its own) are about the set on screen, so
they leave the preference alone and the way back out restores it. A stored
value the set no longer holds falls back for that render without being erased —
the status may well be back after the next edit.

Scrolling views vs
full-bleed fixed views (`body.fixed` for detail + status). Space is partitioned into
regions (main + rail) rather than left-stacked — no dead width.

### The map

My skills draws in three modes: **Table** (dense ledger), **Grid** (cards) and
**Map**. The map is the same data as one circle per skill inside a field per
group, with the extracted relations drawn between them. It reuses the rail
whole: group by any declared axis, every filter, the search box.

A filter narrows the map itself, not a set of rows behind it. The table and the
grid filter in the DOM (`filterLibrary()` hides what does not match); the map
has no rows to hide, so it redraws from `filteredSkills()` — the same predicate
the DOM pass applies, so a rail selection cannot mean one thing in the ledger
and another on the canvas. Everything downstream of the drawn set follows it:
the edges, the mention edges, the lens counts, and every finding in the
inspector. What does _not_ follow it is the Coverage block, which describes the
vault the graph was built from; with a filter on, one line above the findings
says which of the two scopes you are reading.

**The map is two arrivals, not one.** The skills, their groups and their sizes
are already in the browser from `/api/state`; from the graph come only the
edges. So a missing graph is not a missing map: the fields, the circles and the
labels draw either way, at reduced opacity until the relations land on top of
them, and the state of the graph is a line above the canvas rather than a box
standing in for it. A 60ch panel on an empty plot was the picture of a map that
failed to load; the map itself, drawn and honest about what is still coming, is
not. The line disappears when there is nothing to report, and the two states
that can be acted on carry the action (read again, clear filters). The rail's
Relations and Lenses sections go with the edges: with no graph they would be
counting the absence of a file. The inspector says what the state means while
the line says what it is, so the two are complementary rather than the same
sentence twice, 300px apart. Only an empty filtered set leaves a blank plot —
there is genuinely nothing to place.

Nothing is said while the read is in flight. It lasts a few hundred
milliseconds: a sentence that cannot be finished before it disappears is a
flash, not information. The faded circles already say the map is not final, and
the top progress bar already says something is being read. The line is for the
states that persist and can be acted on.

**A finding that owns a list opens in place of the map, not in the rail.** The
inspector is 320px — forty-five characters of prose — and the vault's 81
unpromoted proposals each carry a paragraph of evidence: they made that column
12.812px tall next to a 744px map, and paging them only spreads the same
illegibility over ten screens. The container was wrong, not the quantity. They
are homogeneous records (pair, relation type, score, evidence), so they take
the shape this app already uses for dense lists and the width the content area
already has: a ledger across the full main column, ~1240px, evidence in a real
column of ~800px at two lines, the row opening its own paragraph in place.
Sections are the relation type, biggest first, strongest score first inside —
"what hands off to what" is a different scan from "what duplicates what". No
paging: a table scrolls, which is what tables do.

The rail keeps filtering while the list is open (it is drawn from the same
filtered set, so a filter rebuilds it), and every control that acts on the
canvas — a lens, the mentions toggle, a click on the plot — is read as a
request for the canvas back. A skill name in the list returns to the map with
that skill picked; a proposal is not an extracted edge, so it cannot be
selected as a pair, and pretending otherwise would land on a card the map
cannot draw.

The graph is read once and kept, but an _unusable_ answer is not kept: the
server degrades to `hasGraph:false` when `graph.json` is missing or was caught
half written, and caching that for the session left an empty map that only a
page reload could clear. A retry is gated by a cooldown, because the library
re-renders on every rail click and each render re-enters the map. Refresh drops
the cached graph too, and so does the freshness poll when the pipeline reports a
build commit other than the one on screen — once per commit.

**The armed countdown falls on its own.** The freshness pill showed a figure
only above 60 seconds, and the post-commit hook's quiet window is exactly 60:
every real wait landed in the branch without a number, so the countdown could
not appear at all, and the sentence carrying it inside the panel was built and
then never concatenated into the popover. One threshold now, both sides
carrying the figure (`Refresh in 42s` / `Refresh in 2m`), and zero says
`Starting now` rather than freezing on a number that stopped falling. The tick
is local and rewrites two text nodes once a second: the poll stays at its own
cadence, so nothing is spent on the animation, and no `innerHTML` swap fights
an open popover.

It is deliberately not a force-directed layout. Skills sit on a grid inside
their field and the fields stack in columns of one width, each one dropped into
the column that is currently shortest, so the same vault draws the same map
twice and a node can be pointed at in a conversation. A force layout moves
everything whenever anything changes, which is the opposite of a governance
surface. Circle size carries how much was extracted from the skill; the colour
is the group's taxonomy hue, the same one the chips and section dots use.

The fields used to flow across the canvas and wrap, which made every row as tall
as its tallest field: a 3-skill field beside a 9-skill one carried a whole field
of nothing under it, and on this vault 42% of the canvas was empty while the map
still needed 1388px of scroll. Columns close that gap (85% covered, 1136px) at
one cost: the fields are placed biggest-first, so they are no longer in
alphabetical order. That order lives in the rail, which lists every value with
its count and is where a group is looked up. A row that does not fill its grid
is centred, so a group of one reads as small rather than as broken.

The plot answers "what leans on what". Everything a circle cannot say lives in
the inspector beside it — never a scroll away from what you clicked: which
concepts tie a pair together, what a skill duplicates inside itself, how much
code it carries, and with nothing selected, the findings worth acting on.

**The inspector pins, and it stays pinned.** It rides up with the scroll until
it reaches the top of the column and then holds, which is the whole point of
putting it beside the map. What it must not do is come loose at the end: a
sticky box un-pins when it no longer fits between the top it pins to and the
bottom of its containing block, and the map's containing block ends before the
scroll does — the column's bottom padding is dead space under it. On a
two-screen map the panel slid up by exactly that padding in the last stretch,
which reads as a jump away from what you are reading.

Three things have to hold at once, and each of the first two was tried alone
and failed. Unbounded, the panel slid up in the last stretch — that is the
jump. Bounded but plain-scrolling, its own scrollbar carried its heading away
as you read, which is the same panel leaving by another door. Pinned only when
it happens to fit, it is pinned on a tall window and gone on a short one, which
is worse than either.

So: always pinned, capped to the room that exists (the scrollport's height less
its own padding, top and bottom), and the heading pinned again _inside_ the
panel, so the panel's own scrolling cannot carry away what the column is about.
The room is measured in `paintMap()` rather than written as a viewport formula
because the scrollport sits under a header and a source band whose heights are
not this file's to assume, and an error of a few pixels here is a slide of a
few pixels there. Stacked under 1100px nothing pins at all — the two are one
column, and the inspector reads as what follows the map rather than as what
sits beside it.

The assets carry `cache-control: no-cache`. The bundle has no hash in its name
and the server sent no validator, so a browser was free to decide for itself
how long `ui.js` stays fresh — and it does: a rebuilt dashboard could keep
serving the previous one until a hard reload, which is a fix that looks like it
did not work.

**Two classes of edge, never conflated.** Solid is an extracted relation. Dashed
is a _mention_: one skill naming another by its exact folder name in the
markdown, counted by the server. Mentions are off by default and quieter when
on, because they carry no relation type. They exist because extraction runs one
family at a time (a family being the name prefix before the first dash), so two
skills in different families are never in the same prompt and no relation
between them can be produced: in this vault every extracted cross-skill pair is
intra-family. Reading isolation without that fact overstates it, so the
inspector states it rather than leaving the map to imply a vault problem.

The code graph is a second, independent build that shares no node ids with the
semantic one. It is joined on the skill folder, which is honest about what that
join can support: how much code a skill carries, never which concept it
implements.

## Components

Pill badges with inline SVG (state in words: "All linked" / "Needs attention"
/ "Not active yet"). A skill not yet on every runtime shows a "Link all" shortcut
(detail panel + Status row) that links it into all symlink runtimes at once.
Runtime toggles (switch). Per-file change rows with inline diff
(not cards). Ruled tables for coverage/archive. Confirm dialog + dark toast. Every
write action shows its dry-run plan before it asks to confirm.

**A declared conflict has to read as quiet as a solved one.** `external` and
`disabled` are states the user wrote down, not measurements of disk, so they
take the "off" badge rather than the red one — nothing is wrong with them — and
their switch is disabled with the reason in the title, because there is no
toggle to offer: flipping it on would write over the folder that was
deliberately put outside the vault's reach.

The harder half is everything that _counts_. An overridden pair is not a
measurement of anything, so it leaves the arithmetic entirely: the skill's
health rollup, the per-runtime "N of M linked" in Config, and the library's
linked/partial badge all drop it before judging. Left in, a skill correctly
projected into six runtimes would read "partial" forever because of the
seventh, and the runtime holding one skill of its own would sit at "60 of 61"
and never turn on — which is the report the override exists to end, printed in
three more places.

**The gallery is the rail read as pictures.** A skill whose assets are images
cannot be read one file at a time: thirty filenames that all describe the same
face tell the reader nothing, and telling them apart means opening each one. So
a skill carrying more than one image gets a **Gallery** row in the rail, and
the viewer draws every image it has, in square crops, one section per folder —
finals beside a `black-and-white/` set are two different sets, and a flat grid
of both says they are one. Below two images the grid would be the file itself,
one click further away, so nothing is drawn at all.

**The entry sits above the Files heading, not inside the list under it.** It
first sat inside, above SKILL.md, and read as the first file: same row shape,
same column, one line up. That heading is the separation — everything under it
is a file, and the row before it is not one — and a heading of its own over a
single row, with a rule beneath, only said so twice more. It is a view rather
than a file in every other respect too: it
takes `currentFile` under a key no path can equal, so the rail marks it selected
while no file row is, and the Rendered/Source toggle and the per-file export —
both of which need one file as their subject — step aside while it is open.
Tiles carry a border and no shadow: thirty raised objects would be thirty cards,
and the pictures are the subject. Vectors fit inside their tile while
photographs fill it, because a cropped logo is no longer the logo. The read-only
sources get all of it on the same terms, off their own bytes endpoint.

**A tile opens the picture, not the file.** Looking through photographs is a
different act from reading a file: you compare them, one after another, at a
size worth looking at. So the grid opens a lightbox over the page — path,
position in the set, export, close — and the next image is an arrow key away
rather than a trip back to the grid and out again. It walks the grid's own
reading order, not the raw listing, which sorts a folder's contents before a
sibling file sharing its prefix and would step somewhere the eye did not. The
field behind the picture is dark in both themes: a photograph is judged against
a neutral surround, and a light one tints what is being looked at. The bar rides
over that field rather than taking a band of it, and the picture clears it at
both ends: given the room left under a bar, a photograph sits half a bar-height
low, and centred in the viewport is what centred means here. There is no strip
of thumbnails at the foot — the grid one keystroke away is that strip, at a size
worth looking at. The file itself is still one row away in the rail, and the
export here hands over exactly the bytes the viewer's own export would.

**A folder heading in the rail says only what is new.** The rail is 240px and
the vault nests three deep: `assets / profile-photos / ai-generated` wrapped to
two lines and spent both on a parent the heading above it had just spelled out.
A heading now drops that parent and keeps a leading slash in its place —
`/ ai-generated` under `assets / profile-photos`, spaced like the separators
inside a path so the two sit on one rhythm.

**The slash stands for a parent already written out above, never for one merely
shared.** Eliding against the previous heading alone was wrong on siblings:
`assets/profile-photos` after `assets/avatar-rings` shares "assets", but no
heading ever said "assets" on its own, so the collapse produced
`/ profile-photos` — a sibling wearing the mark of a descendant. A heading now
elides against the deepest heading above it that is a real ancestor (matched on
path boundaries, so `assets/profile` is not a parent of
`assets/profile-photos`), and is written out in full when there is none. What is
shortened is the label and nothing else: the full path is on hover, the file
rows carry it, and the ordering still reads the whole path.

**A picture takes the column it is read in.** A file opened from the rail was
drawn at its own resolution under a cap of the column width, so a wide
photograph filled the page while a 645px one sat in the left half of it, reading
as a thumbnail of itself rather than as the asset. It is scaled to the column
now, and capped at twice its own resolution: past that a small asset — an icon,
a badge, a diagram — is mush rather than a picture, and the honest size is the
one it was drawn at.

**Export** hands a skill folder over as one file — everything under it, zipped
by the server that already has the vault open (`src/zip.ts`: the container the
format needs around what zlib already does, since the project ships with no
runtime dependencies). It sits in the detail's actions and in the right-click
menu, where it also takes a multi-skill selection, and the archive offers it
too: reading is what the archive is for, and taking a copy is reading. The
vault does not move — this is a copy for somewhere that does not have it.

**The detail header holds what you reach for, not the inventory.** The
right-click menu already carries every action a skill has; the header is a
shortcut strip, so it earns its place only for the ones used while reading.
Three equal-weight buttons had no order left to read — with two there was an
implicit one, do and destroy — and the fix was not to rank them but to drop
what was not being reached for: rename left the dashboard altogether, and
archiving went back to the menu, which is where a rare, destructive,
whole-folder move belongs.

Rename left with the capability, not only with the button: the single-skill
route and the pattern-bulk one both went with it. A rename is a name changing
in a folder, in frontmatter and in every link at once, and the mistake it
invites — a batch transform over a selection — is the one shape the dashboard
made easiest to reach. It is a CLI operation now (`skill-loom migrate`), where
it is typed once, for one skill, with both names in front of you. What remains is Export, plus Restore on an archived
skill: it is not destructive, and it is the reason that page gets opened.

The rail's status facet also answers to `s`, which walks the ring "no filter →
each status the set holds → no filter". "All" is a stop on that ring rather
than something you escape by pressing the same value twice, so one key both
narrows and clears — and the ring is built from the set on screen, so the
keyboard walks exactly what the eye can click.

## Bans

Side-stripe accent borders, gradient text, hero-metric blocks, nested cards,
decorative motion, external font/style links, em dashes in UI copy.
