import { afterEach, expect, it, vi } from 'vitest';
import { sanitizeHtml } from '../src/web/client/sanitize-html.js';
// Supply browser-decoded DOM attributes to the actual sanitizer. The browser
// decodes character references before the sanitizer inspects these values.
class FixtureElement {
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  removed = false;
  constructor(readonly tagName: string, public attributes: { name: string; value: string }[]) {}
  remove() { this.removed = true; }
  removeAttribute(name: string) { this.attributes = this.attributes.filter(attribute => attribute.name !== name); }
}
function sanitize(elements: FixtureElement[]) {
  let index = -1;
  const template = { content: {}, innerHTML: '' };
  vi.stubGlobal('NodeFilter', { SHOW_ELEMENT: 1 });
  vi.stubGlobal('document', {
    createElement: () => template,
    createTreeWalker: () => ({ nextNode: () => ++index < elements.length, get currentNode() { return elements[index]; } }),
  });
  sanitizeHtml('fixture');
}
afterEach(() => vi.unstubAllGlobals());
it.each(['javascript:alert(1)', 'java\nscript:alert(1)', '\tjava\tscript:alert(1)', 'data:text/html,attack', 'vbscript:attack'])('removes executable link schemes: %s', value => {
  const link = new FixtureElement('A', [{ name: 'href', value }]);
  sanitize([link]);
  expect(link.attributes).toEqual([]);
});
it('removes foreign content and active attributes while preserving Markdown links', () => {
  const svg = new FixtureElement('svg', []);
  svg.namespaceURI = 'http://www.w3.org/2000/svg';
  const link = new FixtureElement('A', [{ name: 'href', value: 'https://example.com/paper' }, { name: 'onclick', value: 'attack()' }, { name: 'style', value: 'attack' }]);
  const script = new FixtureElement('SCRIPT', []);
  sanitize([svg, link, script]);
  expect(svg.removed).toBe(true);
  expect(script.removed).toBe(true);
  expect(link.removed).toBe(false);
  expect(link.attributes).toEqual([{ name: 'href', value: 'https://example.com/paper' }]);
});
