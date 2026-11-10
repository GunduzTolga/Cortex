/**
 * How many points the graph draws at most. Past it the layout, worked out in
 * the window's own thread before anything is drawn and again at every frame
 * while it settles, held the window still for seconds in a vault of tens of
 * thousands of notes (N11); two thousand points settle in well under a second.
 */
export const GRAPH_POINTS_MAX = 2_000;

interface Point {
  id: string;
  degree: number;
}
interface Line {
  source: string;
  target: string;
}

/**
 * A graph cut to its `max` most linked points, with the lines between them:
 * among points as linked as each other the most recently changed stay, then by
 * name, so the same vault is cut the same way every time. `keep` - the note a
 * local graph is drawn around - always stays. A point keeps the number of its
 * links in the vault, drawn or not, as its size and its hover say it. `hidden`
 * is how many points were left out; a graph within `max` comes back as it was.
 */
export function limitGraph<N extends Point, E extends Line>(
  graph: { nodes: N[]; edges: E[] },
  max: number = GRAPH_POINTS_MAX,
  options: { keep?: string | null; modified?: (id: string) => number } = {},
): { nodes: N[]; edges: E[]; hidden: number } {
  const room = Math.max(0, Math.floor(max));
  if (graph.nodes.length <= room) return { nodes: graph.nodes, edges: graph.edges, hidden: 0 };
  const when = options.modified ?? (() => 0);
  const first = (node: N) => (options.keep != null && node.id === options.keep ? 0 : 1);
  const ranked = [...graph.nodes].sort((a, b) => first(a) - first(b) || b.degree - a.degree || when(b.id) - when(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = new Set(ranked.slice(0, room).map((node) => node.id));
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)),
    hidden: graph.nodes.length - kept.size,
  };
}
