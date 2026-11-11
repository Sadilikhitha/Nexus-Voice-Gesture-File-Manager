/** Wires engines to the dashboard. Every engine start is try/catch'd: failure => classic input only. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Dashboard } from './ui/Dashboard';
import { GestureBridge } from './gesture/GestureBridge';
import { VoiceEngine } from './voice/VoiceEngine';
import { SemanticClient } from './search/SemanticClient';
import { useStore, visibleFiles } from './state/store';
import { pickAndScan, pickFiles, ingestHandles } from './fs/FsAdapter';
import type { FileItem } from './state/store';

const toDoc = (f: FileItem) => ({ id: f.id, name: f.name, modified: f.modified, text: `${f.name.replace(/[_.-]/g, ' ')}. ${f.snippet}` });

/** Workers/blob-workers resolve relative URLs against THEIR OWN location, so always hand them absolute URLs. */
const abs = (p: string) => new URL(p, document.baseURI).href;

export default function App() {
  const voice = useRef<VoiceEngine>(); const gesture = useRef<GestureBridge>(); const semantic = useRef<SemanticClient>();
  const [calMsg, setCalMsg] = useState('');

  // Semantic index + AI tags (local model). If it fails, search falls back to substring match.
  useEffect(() => {
    try {
      const sc = (semantic.current = new SemanticClient());
      const { files, setTags, toast } = useStore.getState();
      sc.index(files.map(f => ({ id: f.id, name: f.name, modified: f.modified, text: `${f.name.replace(/[_.-]/g, ' ')}. ${f.snippet}` })))
        .then(() => sc.tags()).then(setTags)
        .catch(() => toast('Semantic model unavailable — using plain-text search', 'warn'));
    } catch { /* classic search remains */ }
  }, []);

  // Keep the voice grammar in sync with what is on screen.
  useEffect(() => useStore.subscribe((s, p) => {
    if (s.files !== p.files || s.folderId !== p.folderId || s.filter !== p.filter || s.searchIds !== p.searchIds) voice.current?.refreshGrammar();
  }), []);

  const onSearch = useCallback(async (q: string) => {
    const st = useStore.getState();
    try {
      const r = await semantic.current!.search(q);
      st.setSearch(r.hits.map(h => h.id), [r.interpreted && `“${r.interpreted}”`, r.time].filter(Boolean).join(' · '));
    } catch {
      const t = q.toLowerCase();
      st.setSearch(st.files.filter(f => f.name.toLowerCase().includes(t) || f.snippet.toLowerCase().includes(t)).map(f => f.id), 'plain-text fallback');
    }
  }, []);

  /** Real files: pick a folder, scan it, replace the mock data, re-index for semantic search. */
  const openFolder = useCallback(async () => {
    const st = useStore.getState();
    try {
      const res = await pickAndScan();
      if (!res) return;
      st.loadFiles(res.files);
      st.toast(`Loaded ${res.files.length} items from "${res.rootName}"${res.truncated ? ' (limit reached)' : ''}`, 'ok');
      const sc = semantic.current;
      sc?.index(res.files.filter(f => f.kind !== 'folder').map(f => ({ id: f.id, name: f.name, modified: f.modified, text: `${f.name.replace(/[_.-]/g, ' ')}. ${f.snippet}` })))
        .then(() => sc.tags()).then(useStore.getState().setTags)
        .catch(() => useStore.getState().toast('Semantic model unavailable - using plain-text search', 'warn'));
    } catch (e) { st.toast(`Could not open folder: ${(e as Error).message}`, 'warn'); }
  }, []);

  /** Add files/folders (picker or drag-drop) WITHOUT replacing what is already shown. */
  const addHandles = useCallback(async (hs: any[]) => {
    const st = useStore.getState();
    try {
      const r = await ingestHandles(hs);
      st.addFiles(r.files);
      st.toast(`Added ${r.files.length} item${r.files.length === 1 ? '' : 's'}${r.truncated ? ' (limit reached)' : ''}`, 'ok');
      const sc = semantic.current;
      sc?.index(r.files.filter(f => f.kind !== 'folder').map(toDoc), true)
        .then(() => sc.tags()).then(useStore.getState().setTags).catch(() => {});
    } catch (e) { st.toast(`Could not add: ${(e as Error).message}`, 'warn'); }
  }, []);

  const addFiles = useCallback(async () => {
    try { const hs = await pickFiles(); if (hs.length) await addHandles(hs); }
    catch (e) { useStore.getState().toast(`Could not add files: ${(e as Error).message}`, 'warn'); }
  }, [addHandles]);

  const enable = useCallback(async () => {
    // getUserMedia needs a user gesture in some browsers; this runs from a click.
    gesture.current ??= new GestureBridge();
    voice.current ??= new VoiceEngine({
      modelUrl: abs('models/vosk-model-small-en-us-0.15.tar.gz'),
      semanticClient: semantic.current,
      getFiles: () => visibleFiles(useStore.getState()).slice(0, 150).map(f => ({ id: f.id, name: f.name })), // cap keeps the speech grammar small
    });
    await Promise.allSettled([
      gesture.current.start({ wasmPath: abs('mediapipe-wasm'), modelPath: abs('models/hand_landmarker.task') }),
      voice.current.start(),
    ]);
  }, []);

  const calibrate = useCallback(async () => {
    const steps: Record<string, string> = {
      lighting: 'Checking lighting…', open: 'Show an OPEN PALM to the camera (2 s)…', pinch: 'Now PINCH thumb + index and hold (2 s)…', done: '',
    };
    try {
      setCalMsg('Voice: stay quiet for 2.5 s to measure room noise…');
      const v = await voice.current?.calibrate(2500);
      await gesture.current?.calibrate((step, info) => setCalMsg(info ?? steps[step]));
      setCalMsg(`Calibrated${v ? ` · noise floor ${(v.floor * 1000).toFixed(1)}‰` : ''}`);
    } catch (e) { setCalMsg(`Calibration skipped: ${(e as Error).message}`); }
    setTimeout(() => setCalMsg(''), 6000);
  }, []);

  return <Dashboard onAddFiles={addFiles} onAddHandles={addHandles} onOpenFolder={openFolder} onEnableHandsFree={enable} onCalibrate={calibrate} onSearch={onSearch} calibrationMsg={calMsg} />;
}
