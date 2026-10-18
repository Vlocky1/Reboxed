// Small XML reader/writer for attribute-heavy documents such as rekordbox.xml.
// Supports elements, attributes, text, comments, CDATA, <?xml?> and standard entities.

/**
 * @typedef {object} XmlNode
 * @property {string} name
 * @property {Record<string, string>} attrs
 * @property {XmlNode[]} children
 * @property {string} text
 */

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e] ?? m;
  });
}

export function encodeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/**
 * Parse XML text into a tree. Returns the root element.
 * @param {string} text
 * @returns {XmlNode}
 */
export function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack.at(-1).text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { i = src.indexOf('-->', lt) + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      stack.at(-1).text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { i = src.indexOf('>', lt) + 1; continue; }
    const gt = findTagEnd(src, lt);
    if (gt < 0) throw new Error('Unterminated tag');
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      const node = stack.pop();
      if (!node || node.name !== name) throw new Error(`Mismatched </${name}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]|$/);
    const node = { name: inner.slice(0, nameEnd), attrs: {}, children: [], text: '' };
    ATTR_RE.lastIndex = nameEnd;
    let m;
    while ((m = ATTR_RE.exec(inner))) node.attrs[m[1]] = decodeEntities(m[3] ?? m[4]);
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  const top = root.children.find((c) => c.name);
  if (!top) throw new Error('Empty XML document');
  return top;
}

function findTagEnd(src, from) {
  let quote = '';
  for (let j = from + 1; j < src.length; j++) {
    const c = src[j];
    if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return -1;
}

/** Children with a given name. */
export const childrenNamed = (node, name) => node.children.filter((c) => c.name === name);
export const childNamed = (node, name) => node.children.find((c) => c.name === name);

/**
 * Serialise a tree. Nodes with no children are self-closed.
 * @param {XmlNode} node
 */
export function writeXml(node, indent = '') {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${encodeAttr(v)}"`).join('');
  if (!node.children?.length) return `${indent}<${node.name}${attrs}/>`;
  const inner = node.children.map((c) => writeXml(c, `${indent}  `)).join('\n');
  return `${indent}<${node.name}${attrs}>\n${inner}\n${indent}</${node.name}>`;
}
