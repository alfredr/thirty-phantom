const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  parent?: HTMLElement,
  html?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }

  if (html !== undefined) {
    e.innerHTML = html;
  }

  parent?.appendChild(e);
  return e;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v));
  }

  parent?.appendChild(e);
  return e;
}

/** Point on a circle, degrees clockwise from 12 o'clock. */
export function polar(deg: number, r: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [+(Math.sin(a) * r).toFixed(2), +(-Math.cos(a) * r).toFixed(2)];
}
