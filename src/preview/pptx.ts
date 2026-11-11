/** PowerPoint (.pptx) text extraction. A .pptx is a zip of XML; this is the pure, testable part. */
const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

/** One slide's XML -> list of paragraphs (one string per <a:p>). */
export function slideTextFromXml(xml: string): string[] {
  const out: string[] = [];
  for (const para of xml.split('</a:p>')) {
    const text = [...para.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => decode(m[1])).join('').trim();
    if (text) out.push(text);
  }
  return out;
}
export const slideNumber = (name: string) => parseInt(/slide(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10);
export const isSlideXml = (name: string) => /^ppt\/slides\/slide\d+\.xml$/.test(name);
export const isShowableImage = (name: string) => /^ppt\/media\/.+\.(png|jpe?g|gif|webp|svg)$/i.test(name);

/** slideN.xml.rels -> { rId: Target } (attributes can appear in any order). */
export function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = /\bId="([^"]+)"/.exec(tag)?.[1], target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) out[id] = target;
  }
  return out;
}
/** Picture relationship ids used by a slide, in order of appearance, without duplicates. */
export function embedIds(slideXml: string): string[] {
  return [...new Set([...slideXml.matchAll(/r:embed="([^"]+)"/g)].map(m => m[1]))];
}
/** "../media/image1.png" -> "ppt/media/image1.png" */
export function resolveMedia(target: string): string {
  return target.replace(/^(\.\.\/)+/, 'ppt/').replace(/^\/?ppt\/(ppt\/)/, 'ppt/$1').replace(/^\//, '');
}
