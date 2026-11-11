/**
 * Lazy document loaders (each library is only fetched the first time that file type is opened).
 * All run fully offline in the browser.
 */
import { slideTextFromXml, slideNumber, isSlideXml, isShowableImage, parseRels, embedIds, resolveMedia } from './pptx';

/** PDF -> pdf.js document (rendered to canvases by <PdfView>, so zoom and embedded images just work). */
export async function loadPdf(file: File): Promise<any> {
  const pdfjs: any = await import('pdfjs-dist');
  const worker: any = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

/** .docx -> HTML. Embedded pictures are inlined as data: URIs by mammoth, so they display in place. */
export async function loadDocx(file: File): Promise<string> {
  const m: any = await import('mammoth/mammoth.browser');
  const mammoth = m.default ?? m;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return value as string;
}

export interface PptxSlide { paras: string[]; images: string[] }
export interface PptxContent { slides: PptxSlide[]; urls: string[] /* blob URLs, caller revokes */ }

/** .pptx -> per-slide text AND the pictures that slide actually uses (not a pixel-perfect render). */
export async function loadPptx(file: File): Promise<PptxContent> {
  const JSZip: any = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const names: string[] = Object.keys(zip.files);
  const mime = (n: string) => { const e = n.split('.').pop()!.toLowerCase(); return e === 'svg' ? 'image/svg+xml' : e === 'jpg' ? 'image/jpeg' : `image/${e}`; };
  const urls: string[] = [], cache = new Map<string, string>();
  const mediaUrl = async (path: string): Promise<string | null> => {
    if (!isShowableImage(path) || !zip.file(path)) return null;
    if (!cache.has(path)) {
      const u = URL.createObjectURL(new Blob([await zip.file(path).async('arraybuffer')], { type: mime(path) }));
      cache.set(path, u); urls.push(u);
    }
    return cache.get(path)!;
  };
  const slideNames = names.filter(isSlideXml).sort((a, b) => slideNumber(a) - slideNumber(b));
  const slides: PptxSlide[] = [];
  for (const n of slideNames) {
    const xml: string = await zip.file(n).async('string');
    const relsFile = zip.file(`ppt/slides/_rels/slide${slideNumber(n)}.xml.rels`);
    const rels = relsFile ? parseRels(await relsFile.async('string')) : {};
    const images: string[] = [];
    for (const id of embedIds(xml).slice(0, 6)) {
      const u = rels[id] ? await mediaUrl(resolveMedia(rels[id])) : null;
      if (u) images.push(u);
    }
    slides.push({ paras: slideTextFromXml(xml), images });
  }
  return { slides, urls };
}
