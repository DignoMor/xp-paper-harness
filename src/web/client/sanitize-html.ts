// Notes are untrusted HTML, including HTML embedded in Markdown. Keep only
// ordinary formatting; exclude foreign namespaces and active browser content.
const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em',
  'b', 'i', 's', 'del', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'div', 'span',
]);

export function sanitizeHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  while (walker.nextNode()) elements.push(walker.currentNode as Element);
  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !ALLOWED_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const isLink = tag === 'a' && name === 'href';
      const isImage = tag === 'img' && name === 'src';
      const isText = name === 'title' || (tag === 'img' && name === 'alt');
      if ((!isText && !isLink && !isImage) || ((isLink || isImage) && !isSafeUrl(attribute.value, isLink))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  return template.innerHTML;
}

function isSafeUrl(value: string, link: boolean): boolean {
  // Browsers ignore ASCII tabs/newlines within a URL's scheme.
  const normalized = value.replace(/[\u0000-\u0020\u007f]/g, '');
  try {
    const url = new URL(normalized, 'http://localhost');
    return url.protocol === 'http:' || url.protocol === 'https:' || (link && url.protocol === 'mailto:');
  } catch {
    return false;
  }
}
