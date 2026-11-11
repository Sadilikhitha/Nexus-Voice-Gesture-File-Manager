/**
 * Semantic worker: local MiniLM embeddings (Transformers.js / ONNX-WASM) for
 *   - search  : cosine similarity between query and file "documents"
 *   - tagging : zero-shot labels via similarity to label prototypes
 *   - intent  : zero-shot natural language intent classification for voice commands
 * 100% offline: remote models disabled, weights bundled under /models/.
 */
import { pipeline, env } from '@huggingface/transformers';
import { extractTimeHint, cleanQuery } from './timeRange';

env.allowRemoteModels = false;      // zero cloud
env.allowLocalModels = true;

type Extractor = (t: string | string[], o: object) => Promise<{ data: Float32Array; dims: number[] }>;
let extractor: Extractor | undefined;

interface Doc { id: string; text: string; name: string; modified: number; vec?: Float32Array }
const docs = new Map<string, Doc>();

const LABELS: Record<string, string> = {
  Resume: 'resume curriculum vitae job application work experience skills education',
  Finance: 'budget invoice expenses revenue financial report spreadsheet tax',
  Marketing: 'marketing campaign brand social media advertising launch plan audience',
  Code: 'source code programming software function script repository',
  Photo: 'photo picture image screenshot camera scene',
  Notes: 'meeting notes todo list ideas journal minutes',
  Research: 'research paper study abstract methodology results references',
  Legal: 'contract agreement terms legal policy compliance',
};
let labelVecs: [string, Float32Array][] = [];

const INTENT_PROTOTYPES: Record<string, string> = {
  open: 'open the file show me the document display this file launch the document view this file access document bring up file',
  close: 'close the file exit preview dismiss document shut file close it',
  next_page: 'next page move forward one page advance page turn to next page next slide',
  prev_page: 'previous page go back one page move back page turn to previous page prior page',
  first_page: 'open the first page go to starting page start from beginning initial page top of document',
  last_page: 'open the last page go to final page jump to the end take me to ending page bottom of document',
  middle_page: 'jump to the middle of the document go to middle halfway center',
  create_folder: 'create new folder make directory add a folder new directory',
  delete: 'delete file remove document trash file discard file',
  copy: 'copy file duplicate document make a copy duplicate file',
  scroll_down: 'scroll down page down move down look down',
  scroll_up: 'scroll up page up move up look up',
  zoom_in: 'zoom in magnify enlarge scale up zoom closer',
  zoom_out: 'zoom out shrink reduce zoom scale down zoom further',
  show_folders: 'show all folders list folders show directories view folders',
  show_all: 'show all files show everything clear filter reset view',
};
let intentVecs: [string, Float32Array][] = [];

async function embed(texts: string[]): Promise<Float32Array[]> {
  const out = await extractor!(texts, { pooling: 'mean', normalize: true });
  const dim = out.dims[1];
  return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
}
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

self.onmessage = async (e: MessageEvent) => {
  const { id, op, payload } = e.data;
  const reply = (result: unknown) => (self as any).postMessage({ id, result });
  try {
    if (op === 'init') {
      env.localModelPath = payload.base;
      extractor = (await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })) as unknown as Extractor;

      // Label vectors
      const labelNames = Object.keys(LABELS);
      const lVecs = await embed(labelNames.map(n => LABELS[n]));
      labelVecs = labelNames.map((n, i) => [n, lVecs[i]]);

      // Intent prototype vectors
      const intentNames = Object.keys(INTENT_PROTOTYPES);
      const iVecs = await embed(intentNames.map(n => INTENT_PROTOTYPES[n]));
      intentVecs = intentNames.map((n, i) => [n, iVecs[i]]);

      return reply(true);
    }
    if (op === 'reset') { docs.clear(); return reply(true); }
    if (op === 'index') {                       // payload: Doc[] (text = name + snippet + folder)
      const list = payload as Doc[];
      const vecs = await embed(list.map(d => d.text));
      list.forEach((d, i) => docs.set(d.id, { ...d, vec: vecs[i] }));
      return reply(list.length);
    }
    if (op === 'tag') {                         // -> { [id]: string[] }
      const out: Record<string, string[]> = {};
      for (const d of docs.values()) {
        out[d.id] = labelVecs.map(([l, v]) => [l, dot(d.vec!, v)] as const)
          .filter(([, s]) => s > 0.28).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([l]) => l);
      }
      return reply(out);
    }
    if (op === 'search') {                      // payload: { query, k? }
      const { text, hint } = extractTimeHint(payload.query);
      const cleaned = cleanQuery(text) || text;
      const [qv] = await embed([cleaned]);
      const qTokens = cleaned.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const hits = [...docs.values()].map(d => {
        let s = dot(qv, d.vec!);
        if (qTokens.some(t => d.name.toLowerCase().includes(t))) s += 0.10;           // lexical nudge
        if (hint && d.modified >= hint.from && d.modified < hint.to) s += 0.20;        // soft time boost
        return { id: d.id, score: s };
      }).filter(h => h.score >= 0.30).sort((a, b) => b.score - a.score).slice(0, payload.k ?? 12);
      return reply({ hits, interpreted: cleaned, time: hint?.matched ?? null });
    }
    if (op === 'classify-intent') {             // payload: { text }
      const [qv] = await embed([payload.text]);
      let bestIntent = '';
      let bestScore = -1;
      for (const [intent, v] of intentVecs) {
        const score = dot(qv, v);
        if (score > bestScore) {
          bestScore = score;
          bestIntent = intent;
        }
      }
      return reply({ intent: bestIntent, score: bestScore });
    }
  } catch (err) { (self as any).postMessage({ id, error: String((err as Error)?.message ?? err) }); }
};
