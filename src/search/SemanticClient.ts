/** Promise-RPC wrapper around the semantic worker. Failures reject; callers fall back to substring search. */
export interface SearchHit { id: string; score: number }
export interface SearchResult { hits: SearchHit[]; interpreted: string; time: string | null }
export interface IntentMatch { intent: string; score: number }

export class SemanticClient {
  private w = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
  private seq = 0; private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  ready: Promise<void>;

  constructor() {
    this.w.onmessage = (e) => {
      const p = this.pending.get(e.data.id); if (!p) return; this.pending.delete(e.data.id);
      e.data.error ? p.err(new Error(e.data.error)) : p.ok(e.data.result);
    };
    this.ready = this.call('init', { base: new URL('models/', document.baseURI).href }).then(() => undefined);
  }

  private call<T>(op: string, payload?: unknown): Promise<T> {
    return new Promise((ok, err) => { const id = ++this.seq; this.pending.set(id, { ok, err }); this.w.postMessage({ id, op, payload }); });
  }

  /** Replaces the whole index; embeds in small batches so big folders never freeze the worker. */
  async index(docs: { id: string; text: string; name: string; modified: number }[], append = false) {
    await this.ready; if (!append) await this.call('reset'); let n = 0;
    for (let i = 0; i < docs.length; i += 32) n += await this.call<number>('index', docs.slice(i, i + 32));
    return n;
  }

  async tags() { await this.ready; return this.call<Record<string, string[]>>('tag'); }

  async search(query: string, k = 12) { await this.ready; return this.call<SearchResult>('search', { query, k }); }

  async classifyIntent(text: string): Promise<IntentMatch | null> {
    try {
      await this.ready;
      return await this.call<IntentMatch>('classify-intent', { text });
    } catch {
      return null;
    }
  }
}
