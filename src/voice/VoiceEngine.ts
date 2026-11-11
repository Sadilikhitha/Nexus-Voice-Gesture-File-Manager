/**
 * VoiceEngine — fully local, wake-word-gated, grammar-constrained speech control.
 *
 *   mic -> AudioWorklet (adaptive energy gate, render thread)
 *       -> Vosk (WASM, its own Web Worker) with rich natural grammar
 *       -> confidence + duration gates -> CommandParser / MiniLM Semantic fallback -> 'nexus:command'
 *
 * State machine:   ASLEEP --"hey nexus"--> AWAKE(30 s) --command--> AWAKE (session renewed)
 *                                         \--"search"--> DICTATING(1 utt) --> AWAKE
 */
import { createModel, type Model } from 'vosk-browser';
import { emit } from '../shared/bus';
import {
  WAKE_GRAMMAR, buildCommandGrammar, isWakePhrase, parseCommand, type NamedFile,
} from './CommandParser';
import type { SemanticClient } from '../search/SemanticClient';

type Mode = 'asleep' | 'awake' | 'dictating';
type KaldiRecognizer = InstanceType<Model['KaldiRecognizer']>;
const SR = 16000;

export interface VoiceOptions {
  modelUrl: string;                       // e.g. '/models/vosk-model-small-en-us-0.15.tar.gz'
  getFiles: () => NamedFile[];            // currently VISIBLE files (grammar follows the screen)
  semanticClient?: SemanticClient;
  wakeConf?: number; cmdConf?: number; windowMs?: number;
}

export class VoiceEngine {
  private ctx?: AudioContext; private node?: AudioWorkletNode; private stream?: MediaStream;
  private model?: Model;
  private wakeRec?: KaldiRecognizer; private cmdRec?: KaldiRecognizer; private dictRec?: KaldiRecognizer;
  private mode: Mode = 'asleep';
  private awakeTimer?: number;
  private grammarTimer?: number;
  private active?: 'wake' | 'cmd' | 'dict';
  private utterMs = 0;
  private opt: Required<VoiceOptions>;

  constructor(opt: VoiceOptions) {
    this.opt = { wakeConf: 0.55, cmdConf: 0.45, windowMs: 30000, semanticClient: undefined as any, ...opt };
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      this.ctx = new AudioContext({ sampleRate: SR });
      await this.ctx.audioWorklet.addModule(new URL('audio-gate.worklet.js', document.baseURI).href);
      this.node = new AudioWorkletNode(this.ctx, 'audio-gate');
      this.ctx.createMediaStreamSource(this.stream).connect(this.node);
      this.node.port.onmessage = (e) => this.onGate(e.data);

      this.model = await createModel(this.opt.modelUrl);
      this.wakeRec = this.makeRec(JSON.stringify(WAKE_GRAMMAR), 'wake');
      this.refreshGrammar(true);
      this.dictRec = this.makeRec(undefined, 'dict');
      emit('nexus:health', { source: 'voice', ok: true });
    } catch (err) {
      emit('nexus:health', { source: 'voice', ok: false, reason: String((err as Error)?.message ?? err) });
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.awakeTimer); clearTimeout(this.grammarTimer);
    this.node?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
    await this.ctx?.close().catch(() => {});
    for (const r of [this.wakeRec, this.cmdRec, this.dictRec]) r?.remove();
    this.model?.terminate();
    this.node = undefined; this.ctx = undefined; this.stream = undefined; this.model = undefined;
  }

  /** Re-derive the command grammar from the files on screen (debounced). */
  refreshGrammar(immediate = false): void {
    clearTimeout(this.grammarTimer);
    const run = () => {
      if (!this.model) return;
      this.cmdRec?.remove();
      const g = buildCommandGrammar(this.opt.getFiles());
      console.log(`[voice] command grammar rebuilt: ${g.length} phrases`);
      this.cmdRec = this.makeRec(JSON.stringify(g), 'cmd');
    };
    immediate ? run() : (this.grammarTimer = window.setTimeout(run, 250));
  }

  calibrate(ms = 2500): Promise<{ floor: number }> {
    return new Promise((resolve, reject) => {
      if (!this.node) return reject(new Error('voice not started'));
      const h = (e: MessageEvent) => {
        if (e.data.t === 'calibrated') { this.node?.port.removeEventListener('message', h); resolve({ floor: e.data.floor }); }
      };
      this.node.port.addEventListener('message', h);
      this.node.port.postMessage({ t: 'calibrate', ms });
    });
  }

  // ------------------------------------------------------------------ internals
  private makeRec(grammar: string | undefined, kind: 'wake' | 'cmd' | 'dict'): KaldiRecognizer {
    const rec = grammar ? new this.model!.KaldiRecognizer(SR, grammar) : new this.model!.KaldiRecognizer(SR);
    rec.setWords(true);
    rec.on('result', (m: any) => this.onResult(kind, m.result));
    rec.on('partialresult', (m: any) => {
      if (this.mode !== 'asleep' && kind === this.active) emit('nexus:partial', { text: m.result.partial });
    });
    return rec;
  }

  private recFor(): KaldiRecognizer | undefined {
    this.active = this.mode === 'asleep' ? 'wake' : this.mode === 'awake' ? 'cmd' : 'dict';
    return { wake: this.wakeRec, cmd: this.cmdRec, dict: this.dictRec }[this.active];
  }

  private onGate(m: any): void {
    switch (m.t) {
      case 'start': this.utterMs = 0; break;
      case 'audio': this.utterMs += 20; this.recFor()?.acceptWaveformFloat(m.buf, SR); break;
      case 'end': {
        this.recFor()?.acceptWaveformFloat(new Float32Array(SR * 0.7), SR);
        break;
      }
      case 'level': emit('nexus:level', { rms: m.rms, floor: m.floor, speaking: m.speaking }); break;
    }
  }

  private meanConf(res: any): number {
    const w: { conf: number }[] = res?.result ?? [];
    return w.length ? w.reduce((s, x) => s + x.conf, 0) / w.length : 0;
  }

  private async onResult(kind: 'wake' | 'cmd' | 'dict', res: any): Promise<void> {
    const text: string = (res?.text ?? '').trim();
    if (!text) return;
    const conf = this.meanConf(res);
    console.log(`[voice] ${kind} (mode=${this.mode}) heard="${text}" conf=${conf.toFixed(2)} speechMs=${this.utterMs}`);

    if (kind === 'wake' && this.mode === 'asleep') {
      const unk = (text.match(/\[unk\]/g) ?? []).length;
      const cleaned = text.replace(/\[unk\]/g, ' ').replace(/\s+/g, ' ').trim();
      if (isWakePhrase(cleaned) && unk <= 2 && this.utterMs <= 3200 && conf >= this.opt.wakeConf) {
        this.wake('command');
      } else if (/hey|nexus/.test(text)) {
        emit('nexus:rejected', { heard: text, reason: `wake gate: conf ${conf.toFixed(2)}, ${this.utterMs} ms, ${unk} unk` });
      }
      return;
    }

    if (kind === 'dict' && this.mode === 'dictating') {
      const query = text.replace(/\[unk\]/g, '').trim();
      this.mode = 'awake'; this.renew();
      if (query.length > 2) emit('nexus:command', { command: { kind: 'search', query }, heard: text, confidence: conf });
      return;
    }

    if (kind === 'cmd' && this.mode === 'awake') {
      let parsed = parseCommand(text, this.opt.getFiles());

      // If exact grammar didn't catch it, consult MiniLM semantic embeddings
      if (!parsed.ok && this.opt.semanticClient) {
        const match = await this.opt.semanticClient.classifyIntent(text);
        if (match && match.score >= 0.65) {
          console.log(`[voice] MiniLM classified intent="${match.intent}" score=${match.score.toFixed(2)}`);
          switch (match.intent) {
            case 'open': parsed = { ok: true, command: { kind: 'open', target: { by: 'selection' } } }; break;
            case 'close': parsed = { ok: true, command: { kind: 'close' } }; break;
            case 'next_page': parsed = { ok: true, command: { kind: 'pdf-page', page: 'next', delta: 1 } }; break;
            case 'prev_page': parsed = { ok: true, command: { kind: 'pdf-page', page: 'prev', delta: 1 } }; break;
            case 'first_page': parsed = { ok: true, command: { kind: 'pdf-page', page: 'first' } }; break;
            case 'last_page': parsed = { ok: true, command: { kind: 'pdf-page', page: 'last' } }; break;
            case 'middle_page': parsed = { ok: true, command: { kind: 'pdf-page', page: 'middle' } }; break;
            case 'create_folder': parsed = { ok: true, command: { kind: 'create-folder' } }; break;
            case 'delete': parsed = { ok: true, command: { kind: 'delete', target: { by: 'selection' } } }; break;
            case 'copy': parsed = { ok: true, command: { kind: 'copy', target: { by: 'selection' } } }; break;
            case 'scroll_down': parsed = { ok: true, command: { kind: 'scroll', dir: 'down' } }; break;
            case 'scroll_up': parsed = { ok: true, command: { kind: 'scroll', dir: 'up' } }; break;
            case 'zoom_in': parsed = { ok: true, command: { kind: 'zoom', dir: 'in' } }; break;
            case 'zoom_out': parsed = { ok: true, command: { kind: 'zoom', dir: 'out' } }; break;
            case 'show_folders': parsed = { ok: true, command: { kind: 'show-folders' } }; break;
            case 'show_all': parsed = { ok: true, command: { kind: 'show-all' } }; break;
          }
        }
      }

      if (!parsed.ok) {
        console.warn('[voice] not a command:', text, parsed.reason);
        return void emit('nexus:rejected', { heard: text, reason: parsed.reason });
      }

      if (conf < this.opt.cmdConf) {
        return void emit('nexus:rejected', { heard: text, reason: `low confidence ${conf.toFixed(2)}` });
      }

      if (parsed.command.kind === 'begin-search') return this.wake('dictation');
      if (parsed.command.kind === 'sleep') return this.sleep();

      this.renew(); // Stay awake in session
      emit('nexus:command', { command: parsed.command, heard: text, confidence: conf });
    }
  }

  private wake(mode: 'command' | 'dictation'): void {
    this.mode = mode === 'command' ? 'awake' : 'dictating';
    emit('nexus:wake', { active: true, mode });
    clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => this.sleep(), this.opt.windowMs);
  }

  private renew(): void {
    clearTimeout(this.awakeTimer);
    this.awakeTimer = window.setTimeout(() => this.sleep(), this.opt.windowMs);
  }

  private sleep(): void {
    clearTimeout(this.awakeTimer);
    if (this.mode === 'asleep') return;
    this.mode = 'asleep';
    emit('nexus:wake', { active: false, mode: 'command' });
  }
}
