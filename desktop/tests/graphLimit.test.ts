import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import test from 'node:test';
import { vaultGraph, type IndexedNote } from '../core/vaultNotes';
import { GRAPH_POINTS_MAX, limitGraph } from '../src/notes/graphLimit';

/**
 * The graph of a large vault is drawn by its most linked points
 * (src/notes/graphLimit.ts): every point is laid out in the window's own
 * thread, and with no limit a vault of tens of thousands of notes held the
 * window still (N11).
 */

const note = (path: string, links: string[], modified = 0): IndexedNote => ({ path, modified, size: 1, aliases: [], tags: [], links, unresolved: [] });
const OPTIONS = { around: null, depth: 1, orphans: true, missing: false, tags: false, files: false };

test('a graph within the limit is drawn whole, as it was built', () => {
  const graph = vaultGraph([note('a.md', ['b.md']), note('b.md', []), note('c.md', [])], [], OPTIONS);
  const limited = limitGraph(graph);
  assert.equal(limited.nodes, graph.nodes);
  assert.equal(limited.edges, graph.edges);
  assert.equal(limited.hidden, 0);
  assert.equal(limitGraph(graph, 3).hidden, 0, 'exactly at the limit is within it');
});

test('a large vault is cut to its most linked points, with only the lines between them, and says how many it left out', () => {
  // Fifty hubs every note links to in turn, and 9 950 notes of one link each.
  const hubs = Array.from({ length: 50 }, (_, n) => `hub ${n}.md`);
  const notes = [...hubs.map((hub) => note(hub, [])), ...Array.from({ length: 9_950 }, (_, n) => note(`not ${n}.md`, [hubs[n % 50]], n))];
  const graph = vaultGraph(notes, [], OPTIONS);
  assert.equal(graph.nodes.length, 10_000);
  const limited = limitGraph(graph);
  assert.equal(limited.nodes.length, GRAPH_POINTS_MAX);
  assert.equal(limited.hidden, 10_000 - GRAPH_POINTS_MAX);
  const kept = new Set(limited.nodes.map((node) => node.id));
  for (const hub of hubs) assert.ok(kept.has(hub), `${hub} is among the most linked`);
  assert.ok(limited.edges.length > 0 && limited.edges.every((edge) => kept.has(edge.source) && kept.has(edge.target)), 'no line to a point not drawn');
  assert.equal(limited.edges.length, GRAPH_POINTS_MAX - 50, 'every line between two drawn points is kept');
  // A hub keeps the number of its links in the vault, drawn or not: its size and its hover say that.
  assert.equal(limited.nodes.find((node) => node.id === 'hub 0.md')!.degree, 199);
  // In the order they were built in: points already placed keep their place when the graph is made again.
  assert.deepEqual(limited.nodes.map((node) => node.id), graph.nodes.filter((node) => kept.has(node.id)).map((node) => node.id));
  // The same vault, the same cut.
  assert.deepEqual(limitGraph(graph).nodes.map((node) => node.id), limited.nodes.map((node) => node.id));
});

test('among points as linked as each other the most recently changed stay, then by name; the note a graph is drawn around always stays', () => {
  const nodes = [
    { id: 'eski.md', degree: 1 },
    { id: 'orta.md', degree: 1 },
    { id: 'yeni.md', degree: 1 },
    { id: 'merkez.md', degree: 3 },
    { id: 'yalnız.md', degree: 0 },
  ];
  const edges = ['eski.md', 'orta.md', 'yeni.md'].map((source) => ({ source, target: 'merkez.md' }));
  const modified = (id: string) => ({ 'eski.md': 1, 'orta.md': 2, 'yeni.md': 3 })[id] ?? 0;
  const two = limitGraph({ nodes, edges }, 2, { modified });
  assert.deepEqual(two.nodes.map((node) => node.id), ['yeni.md', 'merkez.md']);
  assert.deepEqual(two.edges, [{ source: 'yeni.md', target: 'merkez.md' }]);
  assert.equal(two.hidden, 3);
  assert.deepEqual(limitGraph({ nodes, edges }, 3, { modified }).nodes.map((node) => node.id), ['orta.md', 'yeni.md', 'merkez.md']);
  // With nothing known of when they changed: by name, the same every time.
  assert.deepEqual(limitGraph({ nodes, edges }, 2).nodes.map((node) => node.id), ['eski.md', 'merkez.md']);
  // The note in front is the least linked of all, and is drawn.
  const around = limitGraph({ nodes, edges }, 2, { modified, keep: 'yalnız.md' });
  assert.deepEqual(around.nodes.map((node) => node.id), ['merkez.md', 'yalnız.md']);
  assert.deepEqual(limitGraph({ nodes, edges }, 0).nodes, []);
});

test('the graph view lays out what the limit left, and says so where it cut', () => {
  const view = fs.readFileSync('src/notes/GraphView.tsx', 'utf8');
  // Every graph the view draws comes through the limit: `vaultGraph` is called inside `limitGraph`, nowhere else.
  const built = view.match(/vaultGraph\(/g) ?? [];
  assert.equal(built.length, 1);
  assert.match(view, /limitGraph\(\s*vaultGraph\(/);
  assert.match(view, /graph\.hidden \?[\s\S]{0,200}t\('notes\.graph\.capped', \{ shown: graph\.nodes\.length, hidden: graph\.hidden \}\)/);
  assert.ok(GRAPH_POINTS_MAX >= 500 && GRAPH_POINTS_MAX <= 3_000, 'enough to read a vault by, few enough to lay out in the window');
});
