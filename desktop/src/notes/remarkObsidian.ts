import { splitWikiLink } from '../../core/vaultNotes';

/**
 * What Obsidian adds to Markdown, read into the tree react-markdown draws:
 * `[[wiki links]]` and `![[embeds]]`, `#tags`, `==highlights==`, callouts
 * (`> [!note] Title`), and each block's line in the file, so that a heading,
 * a block or a search hit can be scrolled to and a task ticked in place.
 *
 * Written over the tree remark-gfm leaves, not as a parser extension: a link
 * in code is a code node there already, and is left alone. The new pieces are
 * spans and divs with `data-` attributes, which `NoteMarkdown` draws; nothing
 * here makes a URL, so react-markdown's own check of every link stays the
 * only one.
 */

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  position?: { start: { line: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  [key: string]: unknown;
}

const INLINE = /(!?)\[\[([^[\]\n]+?)\]\]|==([^=\n](?:[^\n]*?[^=\n])?)==|(^|[\s,;(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu;
const BLOCKS = new Set(['heading', 'paragraph', 'listItem', 'blockquote', 'code', 'table', 'thematicBreak', 'html', 'list']);
const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

const span = (props: Record<string, unknown>, children: Node[] = [], name = 'span'): Node => ({
  type: 'obsidian',
  children,
  data: { hName: name, hProperties: props },
});

function splitText(value: string): Node[] | null {
  const out: Node[] = [];
  let at = 0;
  let found = false;
  for (const match of value.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (match[2] !== undefined) {
      const { target, subpath, alias } = splitWikiLink(match[2]);
      if (!target && !subpath) continue;
      if (start > at) out.push({ type: 'text', value: value.slice(at, start) });
      const props = { 'data-wiki': target, 'data-subpath': subpath ?? '', 'data-alias': alias ?? '' };
      out.push(span(match[1] === '!' ? { ...props, 'data-embed': 'true' } : props));
      at = start + match[0].length;
      found = true;
    } else if (match[3] !== undefined) {
      if (start > at) out.push({ type: 'text', value: value.slice(at, start) });
      out.push(span({}, [{ type: 'text', value: match[3] }], 'mark'));
      at = start + match[0].length;
      found = true;
    } else if (match[5] !== undefined) {
      const lead = match[4] ?? '';
      if (start + lead.length > at) out.push({ type: 'text', value: value.slice(at, start + lead.length) });
      out.push(span({ 'data-tag': match[5] }));
      at = start + match[0].length;
      found = true;
    }
  }
  if (!found) return null;
  if (at < value.length) out.push({ type: 'text', value: value.slice(at) });
  return out;
}

/** A callout's type, fold and title from its first line, and that line taken off the quote. */
function callout(node: Node): void {
  const first = node.children?.[0];
  const text = first?.type === 'paragraph' ? first.children?.[0] : undefined;
  if (!first || !text || text.type !== 'text' || typeof text.value !== 'string') return;
  const lineEnd = text.value.indexOf('\n');
  const line = lineEnd < 0 ? text.value : text.value.slice(0, lineEnd);
  const match = CALLOUT.exec(line);
  if (!match) return;
  node.data = {
    ...(node.data ?? {}),
    hName: 'div',
    hProperties: { ...(node.data?.hProperties ?? {}), 'data-callout': match[1].toLowerCase(), 'data-callout-fold': match[2], 'data-callout-title': match[3] },
  };
  const rest = lineEnd < 0 ? '' : text.value.slice(lineEnd + 1);
  if (rest) text.value = rest;
  else {
    first.children!.shift();
    // A line break after the marker leaves the paragraph starting with one.
    if (first.children![0]?.type === 'break') first.children!.shift();
    if (!first.children!.length) node.children!.shift();
  }
}

function walk(node: Node, offset: number, inLink: boolean): void {
  if (BLOCKS.has(node.type) && node.position) {
    node.data = { ...(node.data ?? {}), hProperties: { ...(node.data?.hProperties ?? {}), 'data-line': node.position.start.line - 1 + offset } };
  }
  if (node.type === 'blockquote') callout(node);
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.type === 'text' && !inLink && typeof child.value === 'string') {
      const parts = splitText(child.value);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
      continue;
    }
    walk(child, offset, inLink || child.type === 'link' || child.type === 'linkReference');
  }
  // A paragraph that is one note's embed and nothing else is drawn as a block, as Obsidian draws it.
  if (node.type === 'paragraph' && children.length === 1 && children[0].data?.hProperties?.['data-embed']) {
    children[0].data!.hName = 'div';
    node.data = { ...(node.data ?? {}), hName: 'div' };
  }
}

/** The plugin, given the line the body starts on in the file (past the properties). */
export function remarkObsidian(options: { offset?: number } = {}) {
  return (tree: Node) => walk(tree, options.offset ?? 0, false);
}
