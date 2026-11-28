/**
 * A tiny XML parser, enough for SVG files. It runs anywhere (Node, browsers, workers), unlike
 * DOMParser, which workers and Node don't have.
 */
import { TextrudeError } from './errors.js';

export interface XmlElement {
  /** Tag name, without any namespace prefix ("svg:path" → "path"). */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text and CDATA content directly inside the element. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

/** Parse an XML document and return its root element. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = source.length;
  const fail = (msg: string): never => {
    const line = source.slice(0, i).split('\n').length;
    throw new TextrudeError(`invalid SVG (line ${line}): ${msg}`);
  };
  while (i < n) {
    const lt = source.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decodeEntities(source.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(source.slice(i, lt));
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) fail('unterminated comment');
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0) fail('unterminated CDATA section');
      top.text += source.slice(i + 9, end);
      i = end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) fail('unterminated processing instruction');
      i = end + 2;
    } else if (source.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset in [...].
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        const c = source[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (source[i + 1] === '/') {
      const end = source.indexOf('>', i);
      if (end < 0) fail('unterminated closing tag');
      const name = localName(source.slice(i + 2, end).trim());
      if (stack.length < 2 || top.name !== name) fail(`unexpected </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      const m = /^<([^\s/>]+)/.exec(source.slice(i, i + 256));
      if (!m) fail('bad tag');
      const el: XmlElement = { name: localName(m![1]!), attrs: {}, children: [], text: '' };
      i += m![0].length;
      const attr = /\s*([^\s=/>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/y;
      let selfClosing = false;
      for (;;) {
        while (i < n && /\s/.test(source[i]!)) i++;
        if (source.startsWith('/>', i)) {
          selfClosing = true;
          i += 2;
          break;
        }
        if (source[i] === '>') {
          i++;
          break;
        }
        if (i >= n) fail(`unterminated <${el.name}>`);
        attr.lastIndex = i;
        const a = attr.exec(source);
        if (!a || a.index !== i) fail(`bad attribute in <${el.name}>`);
        let value = a![2] ?? '';
        if (value[0] === '"' || value[0] === "'") value = value.slice(1, -1);
        el.attrs[a![1]!] = decodeEntities(value);
        i = attr.lastIndex;
      }
      top.children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length > 1) fail(`unclosed <${stack[stack.length - 1]!.name}>`);
  const el = root.children[0];
  if (!el) throw new TextrudeError('invalid SVG: no root element');
  return el;
}
