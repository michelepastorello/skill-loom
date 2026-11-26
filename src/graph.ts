import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { skillMarkdownFiles } from "./vault.js";

/** A knowledge graph built over the vault, projected down to the skill level.
 *
 *  The raw graph is concept-level: ~2k nodes for a 76-skill vault, which is a
 *  hairball on screen and 1.5 MB on the wire. Everything here folds it onto the
 *  one unit the dashboard already governs — the skill folder — so the browser
 *  receives tens of kilobytes and every number traces back to a file on disk.
 */

/** Extraction runs one family at a time and a family is the name prefix before
 *  the first dash, so two skills in different families are never in the same
 *  prompt and no relation between them can be extracted. The dashboard needs
 *  the same rule to explain why a skill looks isolated. */
export function familyOf(skill: string): string {
  const cut = skill.indexOf("-");
  return cut === -1 ? skill : skill.slice(0, cut);
}

/** Mentions below this are noise: one skill listing another in a "see also"
 *  line says less than the extractor missing a real handoff. Two independent
 *  occurrences is the floor where the pair is worth showing. */
export const MENTION_MIN = 2;

export interface GraphSkill {
  concept: number;
  document: number;
  rationale: number;
  /** Concept pairs the extractor marked as duplicates of each other, inside
   *  this one skill. Merge candidates, not errors. */
  dupes: [string, string][];
  /** Files from the code graph, when one exists and covers this skill. */
  code?: { nodes: number; files: { path: string; nodes: number }[] };
}

export interface GraphEdge {
  a: string;
  b: string;
  weight: number;
  relations: Record<string, number>;
  /** Up to a handful of the concept-level relations behind the pair, so the
   *  UI can show what actually links them rather than only how much. */
  samples: { rel: string; source: string; target: string }[];
}

/** A cross-family relation the pipeline proposed but did not promote: the model
 *  confirmed it and quoted its evidence, yet scored it below the floor the vault
 *  serves. Kept visible on purpose — the score is a coarse self-report, and a
 *  human reading the quote decides in seconds what a threshold cannot. */
export interface WeakCrossEdge {
  a: string;
  b: string;
  relation: string;
  evidence: string;
  score: number;
}

export interface GraphMention {
  a: string;
  b: string;
  weight: number;
  crossFamily: boolean;
}

export interface CodeGraphMeta {
  nodes: number;
  edges: number;
  skills: number;
  builtAtCommit: string | null;
  /** Commits from the code graph's build commit to HEAD, or null when it can't
   *  be told honestly (not a repo root, unknown commit, rewritten history). */
  commitsBehind: number | null;
}

export interface VaultGraph {
  hasGraph: boolean;
  skills: Record<string, GraphSkill>;
  edges: GraphEdge[];
  mentions: GraphMention[];
  /** Empty in a vault whose pipeline does not write a cross layer. */
  weakCross: WeakCrossEdge[];
  meta: {
    nodes: number;
    links: number;
    communities: number;
    builtAtCommit: string | null;
    /** Skills with at least one node in the graph, over skills on disk. */
    skillsIndexed: number;
    skillsOnDisk: number;
    families: number;
    singletonFamilies: number;
    crossFamilyEdges: number;
    crossFamilyMentions: number;
    code: CodeGraphMeta | null;
  };
}

interface RawNode {
  id: string;
  label?: string;
  file_type?: string;
  source_file?: string;
  community?: number;
}
interface RawLink {
  source: string;
  target: string;
  relation?: string;
}
interface RawGraph {
  nodes?: RawNode[];
  links?: RawLink[];
  built_at_commit?: string;
}

function readGraph(file: string): RawGraph | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as RawGraph;
  } catch {
    // The graph is written by an external pipeline; a half-written or corrupt
    // file must degrade to "no graph", never take the dashboard down.
    return null;
  }
}

const ownerOf = (node: RawNode | undefined): string => {
  const source = node?.source_file ?? "";
  const cut = source.indexOf("/");
  return cut === -1 ? source : source.slice(0, cut);
};

/** One pass over every markdown file in the vault, counting where a skill names
 *  another by its exact folder name. Deterministic and free: it is what is left
 *  when extraction cannot see across families. */
export function scanMentions(
  vaultDir: string,
  skillNames: string[],
): GraphMention[] {
  if (skillNames.length < 2) return [];
  // Longest first, so `skill-loom` wins over a hypothetical `skill`.
  const byLength = [...skillNames].sort((a, b) => b.length - a.length);
  const alternation = byLength
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(`(?<![\\w-])(${alternation})(?![\\w-])`, "g");
  const known = new Set(skillNames);
  const counts = new Map<string, number>();

  for (const skill of skillNames) {
    const dir = path.join(vaultDir, skill);
    let files: string[];
    try {
      files = skillMarkdownFiles(dir);
    } catch {
      continue;
    }
    for (const rel of files) {
      let text: string;
      try {
        text = readFileSync(path.join(dir, rel), "utf8");
      } catch {
        continue;
      }
      for (const match of text.matchAll(re)) {
        const other = match[1];
        if (other === skill || !known.has(other)) continue;
        const key = [skill, other].sort().join(" ");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  const out: GraphMention[] = [];
  for (const [key, weight] of counts) {
    if (weight < MENTION_MIN) continue;
    const [a, b] = key.split(" ");
    out.push({ a, b, weight, crossFamily: familyOf(a) !== familyOf(b) });
  }
  return out.sort((x, y) => y.weight - x.weight || x.a.localeCompare(y.a));
}

const SAMPLE_CAP = 6;

/** Proposals sitting in the cross layer that never made it into the graph.
 *  Read straight from the pipeline's own file: anything already served as an
 *  edge is dropped, so this only ever shows what is waiting for a decision. */
function readWeakCross(
  vaultDir: string,
  known: Set<string>,
  served: Map<string, GraphEdge>,
): WeakCrossEdge[] {
  const raw = readGraph(
    path.join(vaultDir, "graphify-out", ".graphify_cross.json"),
  );
  const edges = (raw as { edges?: unknown } | null)?.edges;
  if (!Array.isArray(edges)) return [];
  const out: WeakCrossEdge[] = [];
  for (const item of edges) {
    if (!item || typeof item !== "object") continue;
    const edge = item as Record<string, unknown>;
    const a = typeof edge.a === "string" ? edge.a : "";
    const b = typeof edge.b === "string" ? edge.b : "";
    if (!known.has(a) || !known.has(b)) continue;
    const [x, y] = [a, b].sort();
    if (served.has(`${x} ${y}`)) continue;
    out.push({
      a,
      b,
      relation: typeof edge.relation === "string" ? edge.relation : "related",
      evidence: typeof edge.evidence === "string" ? edge.evidence : "",
      score:
        typeof edge.confidence_score === "number" ? edge.confidence_score : 0,
    });
  }
  return out.sort((p, q) => q.score - p.score || p.a.localeCompare(q.a));
}

/** Project the raw graphs onto the skills that exist on disk. `skillNames` is
 *  the vault's own list, so a node under a folder that is no longer a skill is
 *  dropped rather than inventing a skill the dashboard cannot open. */
export function projectGraph(
  vaultDir: string,
  skillNames: string[],
  commitsBehind: (commit: string | null) => number | null,
): VaultGraph {
  const known = new Set(skillNames);
  const families = new Set(skillNames.map(familyOf));
  const familySize = new Map<string, number>();
  for (const name of skillNames)
    familySize.set(familyOf(name), (familySize.get(familyOf(name)) ?? 0) + 1);

  const empty: VaultGraph = {
    hasGraph: false,
    skills: {},
    edges: [],
    mentions: [],
    weakCross: [],
    meta: {
      nodes: 0,
      links: 0,
      communities: 0,
      builtAtCommit: null,
      skillsIndexed: 0,
      skillsOnDisk: skillNames.length,
      families: families.size,
      singletonFamilies: [...familySize.values()].filter((n) => n === 1).length,
      crossFamilyEdges: 0,
      crossFamilyMentions: 0,
      code: null,
    },
  };

  const doc = readGraph(path.join(vaultDir, "graphify-out", "graph.json"));
  if (!doc || !Array.isArray(doc.nodes)) return empty;

  const nodes = new Map<string, RawNode>();
  const skills: Record<string, GraphSkill> = {};
  const communities = new Set<number>();
  for (const node of doc.nodes) {
    if (!node || typeof node.id !== "string") continue;
    nodes.set(node.id, node);
    if (typeof node.community === "number") communities.add(node.community);
    const owner = ownerOf(node);
    if (!known.has(owner)) continue;
    const entry = (skills[owner] ??= {
      concept: 0,
      document: 0,
      rationale: 0,
      dupes: [],
    });
    if (node.file_type === "document") entry.document += 1;
    else if (node.file_type === "rationale") entry.rationale += 1;
    else entry.concept += 1;
  }

  const pairs = new Map<string, GraphEdge>();
  const links = Array.isArray(doc.links) ? doc.links : [];
  for (const link of links) {
    if (!link || typeof link.source !== "string") continue;
    const a = ownerOf(nodes.get(link.source));
    const b = ownerOf(nodes.get(link.target));
    if (!known.has(a) || !known.has(b)) continue;
    const relation = link.relation ?? "related";
    if (a === b) {
      if (relation === "duplicates")
        skills[a]?.dupes.push([
          nodes.get(link.source)?.label ?? link.source,
          nodes.get(link.target)?.label ?? link.target,
        ]);
      continue;
    }
    const [x, y] = [a, b].sort();
    const key = `${x} ${y}`;
    let edge = pairs.get(key);
    if (!edge) {
      edge = { a: x, b: y, weight: 0, relations: {}, samples: [] };
      pairs.set(key, edge);
    }
    edge.weight += 1;
    edge.relations[relation] = (edge.relations[relation] ?? 0) + 1;
    if (edge.samples.length < SAMPLE_CAP)
      edge.samples.push({
        rel: relation,
        source: nodes.get(link.source)?.label ?? link.source,
        target: nodes.get(link.target)?.label ?? link.target,
      });
  }

  const edges = [...pairs.values()].sort(
    (a, b) => b.weight - a.weight || a.a.localeCompare(b.a),
  );
  const mentions = scanMentions(vaultDir, skillNames).filter(
    (m) => !pairs.has(`${m.a} ${m.b}`),
  );

  // The code graph is a second, independent build (AST, no tokens). It shares
  // no node ids with the semantic one, so the skill folder is the only join:
  // it can say how much code a skill has, never which concept that code
  // implements.
  const codeRaw = readGraph(path.join(vaultDir, "graphify-code", "graph.json"));
  let code: CodeGraphMeta | null = null;
  if (codeRaw && Array.isArray(codeRaw.nodes)) {
    const perSkill = new Map<string, Map<string, number>>();
    for (const node of codeRaw.nodes) {
      const source = node?.source_file ?? "";
      const owner = ownerOf(node);
      if (!known.has(owner)) continue;
      const files = perSkill.get(owner) ?? new Map<string, number>();
      const rel = source.slice(owner.length + 1);
      files.set(rel, (files.get(rel) ?? 0) + 1);
      perSkill.set(owner, files);
    }
    for (const [owner, files] of perSkill) {
      const entry = (skills[owner] ??= {
        concept: 0,
        document: 0,
        rationale: 0,
        dupes: [],
      });
      entry.code = {
        nodes: [...files.values()].reduce((sum, n) => sum + n, 0),
        files: [...files.entries()]
          .map(([p, nodes]) => ({ path: p, nodes }))
          .sort((x, y) => x.path.localeCompare(y.path)),
      };
    }
    const builtAt = codeRaw.built_at_commit ?? null;
    code = {
      nodes: codeRaw.nodes.length,
      edges: Array.isArray(codeRaw.links) ? codeRaw.links.length : 0,
      skills: perSkill.size,
      builtAtCommit: builtAt,
      commitsBehind: commitsBehind(builtAt),
    };
  }

  return {
    hasGraph: true,
    skills,
    edges,
    mentions,
    weakCross: readWeakCross(vaultDir, known, pairs),
    meta: {
      nodes: doc.nodes.length,
      links: links.length,
      communities: communities.size,
      builtAtCommit: doc.built_at_commit ?? null,
      skillsIndexed: Object.keys(skills).filter(
        (k) => skills[k].concept + skills[k].document + skills[k].rationale > 0,
      ).length,
      skillsOnDisk: skillNames.length,
      families: families.size,
      singletonFamilies: [...familySize.values()].filter((n) => n === 1).length,
      crossFamilyEdges: edges.filter((e) => familyOf(e.a) !== familyOf(e.b))
        .length,
      crossFamilyMentions: mentions.filter((m) => m.crossFamily).length,
      code,
    },
  };
}

/** Reading and folding 1.5 MB of JSON on every poll is wasted work: the graph
 *  only changes when the pipeline rewrites it. Keyed on the two graph files'
 *  mtime and size, so an external rebuild invalidates without a restart. */
const cache = new Map<string, { key: string; value: VaultGraph }>();

function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

export function cacheKey(vaultDir: string): string {
  return [
    stamp(path.join(vaultDir, "graphify-out", "graph.json")),
    stamp(path.join(vaultDir, "graphify-code", "graph.json")),
  ].join("|");
}

export function readVaultGraph(
  vaultDir: string,
  skillNames: string[],
  commitsBehind: (commit: string | null) => number | null,
): VaultGraph {
  const key = `${cacheKey(vaultDir)}|${skillNames.join(",")}`;
  const hit = cache.get(vaultDir);
  if (hit && hit.key === key) return hit.value;
  const value = projectGraph(vaultDir, skillNames, commitsBehind);
  cache.set(vaultDir, { key, value });
  return value;
}
