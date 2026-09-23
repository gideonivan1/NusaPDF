/**
 * Minimal helpers for walking WordprocessingML with a DOM.
 *
 * OOXML elements are namespaced (`w:p`, `wp:anchor`, `a:blip`) and parsers
 * disagree on whether `localName` keeps the prefix, so every lookup strips it
 * and compares the bare name. Attribute lookup does the same: `w:val`,
 * `r:embed`, and plain `cx` are all found by their local part.
 */

export function localName(node: Element): string {
  const name = node.localName ?? node.nodeName ?? '';
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function children(element: Element | null | undefined, name?: string): Element[] {
  if (!element) return [];
  const out: Element[] = [];
  for (const child of Array.from(element.children ?? [])) {
    if (!name || localName(child) === name) out.push(child);
  }
  return out;
}

export function child(element: Element | null | undefined, name: string): Element | undefined {
  if (!element) return undefined;
  for (const node of Array.from(element.children ?? [])) {
    if (localName(node) === name) return node;
  }
  return undefined;
}

/** Follows a chain of child names: `path(tcPr, 'tcBorders', 'top')`. */
export function path(element: Element | null | undefined, ...names: string[]): Element | undefined {
  let current: Element | undefined = element ?? undefined;
  for (const name of names) {
    current = child(current, name);
    if (!current) return undefined;
  }
  return current;
}

/** All descendants with a local name, in document order. */
export function descendants(element: Element | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: Element) => {
    for (const next of Array.from(node.children ?? [])) {
      if (localName(next) === name) out.push(next);
      walk(next);
    }
  };
  if (element) walk(element);
  return out;
}

export function attr(element: Element | null | undefined, name: string): string | null {
  if (!element) return null;
  const direct = element.getAttribute(`w:${name}`) ?? element.getAttribute(name);
  if (direct !== null) return direct;
  for (const attribute of Array.from(element.attributes ?? [])) {
    const colon = attribute.name.indexOf(':');
    const bare = colon === -1 ? attribute.name : attribute.name.slice(colon + 1);
    if (bare === name) return attribute.value;
  }
  return null;
}

export const val = (element: Element | null | undefined) => attr(element, 'val');

/**
 * OOXML toggles: `<w:b/>` and `<w:b w:val="1"/>` are on, `<w:b w:val="0"/>`
 * is off, absence is "inherit".
 */
export function toggle(element: Element | null | undefined): boolean | undefined {
  if (!element) return undefined;
  const value = val(element);
  if (value === null) return true;
  return !(value === '0' || value === 'false' || value === 'off' || value === 'none');
}

export function num(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Twentieths of a point → points. */
export const twips = (value: number | undefined) => (value === undefined ? undefined : value / 20);
/** English Metric Units → points. */
export const emu = (value: number | undefined) => (value === undefined ? undefined : value / 12700);

export function parseXml(text: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  const root = document.documentElement;
  if (!root || localName(root) === 'parsererror' || document.getElementsByTagName('parsererror').length > 0) {
    throw new Error('XML di dalam dokumen Word tidak dapat dibaca');
  }
  return document;
}
