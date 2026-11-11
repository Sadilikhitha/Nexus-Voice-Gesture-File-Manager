/**
 * Glassmorphism dashboard. Reacts to voice + gesture events with visual feedback:
 *   - air-click ripple at the tap point        - listening ring while the wake window is open
 *   - hand cursor (updated via ref, NOT React state, so it tracks at display refresh rate)
 *   - live transcript chip, scroll indicator, gesture-state pill, per-modality health
 *   - complete file management toolbar (New Folder, Rename, Delete, Copy, Move)
 * Keyboard + mouse are always live: they are the fail-safe path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { on } from '../shared/bus';
import { getHandle } from '../fs/FsAdapter';
import { loadDocx, loadPdf, loadPptx } from '../preview/loaders';
import { PdfView } from './PdfView';
import { useStore, visibleFiles, type FileItem, type Kind } from '../state/store';

const KIND_STYLE: Record<Kind, { icon: string; grad: string }> = {
  folder: { icon: '📁', grad: 'from-amber-400/40 to-orange-500/20' },
  pdf:    { icon: '📕', grad: 'from-rose-400/40 to-red-500/20' },
  docx:   { icon: '📘', grad: 'from-sky-400/40 to-blue-500/20' },
  slides: { icon: '📊', grad: 'from-orange-400/40 to-red-500/20' },
  txt:    { icon: '📄', grad: 'from-slate-300/30 to-slate-500/20' },
  image:  { icon: '🖼️', grad: 'from-fuchsia-400/40 to-pink-500/20' },
  code:   { icon: '🧩', grad: 'from-emerald-400/40 to-teal-500/20' },
  other:  { icon: '📦', grad: 'from-slate-300/30 to-slate-500/20' },
};
const fmt = (ms: number, long = false) => !ms ? '—' : long ? new Date(ms).toLocaleString() : new Date(ms).toLocaleDateString();
const FILTERS: { label: string; kind: Kind | null }[] = [
  { label: 'All', kind: null }, { label: 'PDF', kind: 'pdf' }, { label: 'Word', kind: 'docx' }, { label: 'Slides', kind: 'slides' },
  { label: 'Text', kind: 'txt' }, { label: 'Images', kind: 'image' }, { label: 'Code', kind: 'code' },
];

export interface DashboardProps {
  onAddFiles(): void; onAddHandles(h: any[]): void; onOpenFolder(): void; onEnableHandsFree(): void; onCalibrate(): void;
  onSearch(q: string): Promise<void>; calibrationMsg: string;
}

export function Dashboard({ onAddFiles, onAddHandles, onOpenFolder, onEnableHandsFree, onCalibrate, onSearch, calibrationMsg }: DashboardProps) {
  const s = useStore();
  const list = useMemo(() => visibleFiles(s), [s.files, s.folderId, s.filter, s.searchIds, s.sort]);
  const [dbg, setDbg] = useState('');
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const [scrollDir, setScrollDir] = useState<'up' | 'down' | null>(null);
  const [query, setQuery] = useState('');
  const [help, setHelp] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Modals for File Operations
  const [modalType, setModalType] = useState<'new-folder' | 'rename' | 'move' | null>(null);
  const [modalInput, setModalInput] = useState('');

  const cursorRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef<string | null>(null);

  // ---- tap on a file card: first tap selects, tap on selected card opens
  const handleCardTap = useCallback((id: string) => {
    const st = useStore.getState();
    if (st.selectedId === id) st.open({ by: 'file', fileId: id }); else st.select(id);
  }, []);

  // ---- subscribe to input events once
  useEffect(() => {
    let rippleId = 0, scrollTimer = 0;
    // Edge-hold paging (no fast swipe needed): while a file is open, park the cursor at the far
    // right edge for ~0.6 s = next page, far left edge = previous page; keeps flipping every 0.9 s while held.
    let edgeSide: 'l' | 'r' | null = null, edgeSince = 0, edgeLastFire = 0;
    const offs = [
      on('nexus:tap', ({ x, y }) => {
        const id = ++rippleId;
        setRipples(r => [...r, { id, x, y }]); setTimeout(() => setRipples(r => r.filter(q => q.id !== id)), 750);
        const card = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-file-id]');
        if (card) handleCardTap(card.dataset.fileId!);
      }),
      on('nexus:cursor', ({ x, y, visible, pinching }) => {
        {
          const st = useStore.getState(), W = window.innerWidth, now = performance.now();
          const side: 'l' | 'r' | null = !visible || pinching || !st.openId ? null : x < W * 0.07 ? 'l' : x > W * 0.93 ? 'r' : null;
          if (side !== edgeSide) { edgeSide = side; edgeSince = now; edgeLastFire = 0; }
          else if (side && now - edgeSince >= 600 && now - edgeLastFire >= 900) {
            edgeLastFire = now; st.pdfNav(side === 'r' ? 'next' : 'prev');
          }
        }
        const el = cursorRef.current; if (!el) return;
        el.style.opacity = visible ? '1' : '0';
        el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${pinching ? 0.7 : 1})`;
        const card = visible ? (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-file-id]') : null;
        const id = card?.dataset.fileId ?? null;
        if (id !== hoverRef.current) {
          document.querySelector('[data-hover="1"]')?.removeAttribute('data-hover');
          card?.setAttribute('data-hover', '1'); hoverRef.current = id;
        }
      }),
      // Unified Responsive Swipes
      on('nexus:nav', ({ dir }) => {
        // Thumb-up + index-pointing gesture. Back: previous page (closes the file from page 1), else up one level.
        const st = useStore.getState();
        if (dir === 'back') {
          if (st.openId && st.pdfCurrentPage > 1) st.pdfNav('prev'); else st.back();
        } else {
          if (st.openId) st.pdfNav('next'); else st.forward();
        }
      }),
      on('nexus:swipe', ({ dir }) => {
        const st = useStore.getState();
        if (dir === 'left') {
          // Right-to-left swipe: Next page in PDF or next item / forward
          if (st.openId) {
            st.pdfNav('next');
          } else {
            const vis = visibleFiles(st);
            const idx = vis.findIndex(f => f.id === st.selectedId);
            if (idx >= 0 && idx < vis.length - 1) st.select(vis[idx + 1].id);
            else if (idx === -1 && vis.length > 0) st.select(vis[0].id);
            else st.forward();
          }
        } else if (dir === 'right') {
          // Left-to-right swipe: Previous page in PDF or previous item / back
          if (st.openId) {
            st.pdfNav('prev');
          } else {
            const vis = visibleFiles(st);
            const idx = vis.findIndex(f => f.id === st.selectedId);
            if (idx > 0) st.select(vis[idx - 1].id);
            else st.back();
          }
        } else if (dir === 'up') {
          // Swipe up: scroll up
          setScrollDir('up');
          clearTimeout(scrollTimer);
          scrollTimer = window.setTimeout(() => setScrollDir(null), 300);
          const target = [...document.querySelectorAll<HTMLElement>('[data-nexus-scroll]')].at(-1);
          target?.scrollBy({ top: -350, behavior: 'smooth' });
        } else if (dir === 'down') {
          // Swipe down: scroll down
          setScrollDir('down');
          clearTimeout(scrollTimer);
          scrollTimer = window.setTimeout(() => setScrollDir(null), 300);
          const target = [...document.querySelectorAll<HTMLElement>('[data-nexus-scroll]')].at(-1);
          target?.scrollBy({ top: 350, behavior: 'smooth' });
        }
      }),
      on('nexus:gesture-debug', ({ text }) => setDbg(text)),
      on('nexus:zoom', ({ delta }) => useStore.getState().zoomBy(delta)),
      on('nexus:scroll', ({ dy }) => { setScrollDir(dy < 0 ? 'up' : 'down'); clearTimeout(scrollTimer); scrollTimer = window.setTimeout(() => setScrollDir(null), 250); }),
      on('nexus:gesture-state', ({ state }) => {
        useStore.getState().set({ gesture: state });
        if (state === 'paused') useStore.getState().toast('✋ Gestures Paused — Show open palm to resume', 'info');
        else if (state === 'engaged') useStore.getState().toast('👋 Gestures Active', 'ok');
      }),
      on('nexus:wake', ({ active }) => useStore.getState().set({ wakeActive: active, transcript: active ? '' : useStore.getState().transcript })),
      on('nexus:partial', ({ text }) => useStore.getState().set({ transcript: text })),
      on('nexus:command', ({ command, heard }) => { useStore.getState().set({ transcript: `“${heard}”` }); useStore.getState().run(command); }),
      on('nexus:rejected', ({ heard, reason }) => useStore.getState().toast(`Didn't act on “${heard}” (${reason})`, 'warn')),
      on('nexus:health', ({ source, ok, reason }) => {
        useStore.getState().set({ health: { ...useStore.getState().health, [source]: ok }, healthReason: { ...useStore.getState().healthReason, [source]: ok ? '' : (reason ?? 'error') } });
        if (!ok) useStore.getState().toast(`${source === 'voice' ? 'Voice' : 'Gesture'} unavailable (${reason ?? 'error'}) — keyboard & mouse still work`, 'warn');
        else useStore.getState().toast(`${source === 'voice' ? 'Voice' : 'Gesture'} control ready`, 'ok');
      }),
    ];
    const doSearch = (e: Event) => { const q = (e as CustomEvent<string>).detail; setQuery(q); onSearch(q); };
    window.addEventListener('nexus:do-search', doSearch);
    return () => { offs.forEach(o => o()); window.removeEventListener('nexus:do-search', doSearch); };
  }, [handleCardTap, onSearch]);

  // ---- keyboard path (always on)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const st = useStore.getState(), vis = visibleFiles(st), i = vis.findIndex(f => f.id === st.selectedId);
      const cols = Math.max(1, Math.floor((document.querySelector('[data-grid]')?.clientWidth ?? 800) / (190 * st.zoom)));
      const move = (d: number) => { const n = vis[Math.min(vis.length - 1, Math.max(0, (i < 0 ? 0 : i + d)))]; if (n) st.select(n.id); };
      if (e.key === 'ArrowRight') move(1); else if (e.key === 'ArrowLeft') move(-1);
      else if (e.key === 'ArrowDown') move(cols); else if (e.key === 'ArrowUp') move(-cols);
      else if (e.key === 'Enter') st.open({ by: 'selection' });
      else if (e.key === 'Escape') { st.close(); setHelp(false); setModalType(null); }
      else if (e.key === '?') setHelp(h => !h);
      else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) st.back();
      else if (e.altKey && e.key === 'ArrowRight') st.forward();
      else if (e.key === '+' || e.key === '=') st.zoomBy(1.15); else if (e.key === '-') st.zoomBy(1 / 1.15);
      else if (e.key === 'Delete') st.deleteFile();
      else return; e.preventDefault();
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);

  const open = s.files.find(f => f.id === s.openId);
  const selectedFile = s.files.find(f => f.id === s.selectedId);

  const handleModalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (modalType === 'new-folder') {
      s.createFolder(modalInput.trim() || undefined);
    } else if (modalType === 'rename') {
      s.renameFile(s.selectedId || undefined, modalInput.trim());
    } else if (modalType === 'move') {
      s.moveFile(s.selectedId || undefined, modalInput.trim());
    }
    setModalType(null);
    setModalInput('');
  };

  return (
    <div className="relative h-full overflow-hidden bg-slate-950 font-sans text-white select-none"
      onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => {
        e.preventDefault(); setDragging(false);
        const pending = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => (i as any).getAsFileSystemHandle?.());
        Promise.all(pending).then(hs => { const ok = hs.filter(Boolean); ok.length ? onAddHandles(ok) : useStore.getState().toast('Drop not supported here - use ➕ Add files', 'warn'); });
      }}>
      {dragging && <div className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-3xl border-4 border-dashed border-cyan-300/70 bg-cyan-400/10 text-2xl backdrop-blur-sm">Drop files or folders to add them</div>}

      {/* animated aurora background */}
      <div className="pointer-events-none absolute inset-0">
        <div className="nx-blob absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-violet-600/40 blur-[110px]" />
        <div className="nx-blob absolute right-0 top-1/3 h-[26rem] w-[26rem] rounded-full bg-cyan-500/30 blur-[110px]" style={{ animationDelay: '-6s' }} />
        <div className="nx-blob absolute bottom-0 left-1/3 h-[24rem] w-[24rem] rounded-full bg-fuchsia-500/25 blur-[110px]" style={{ animationDelay: '-12s' }} />
      </div>

      <div className="relative z-10 flex h-full gap-4 p-4">
        {/* ---- sidebar */}
        <aside className="glass flex w-56 shrink-0 flex-col gap-1 rounded-3xl p-4">
          <div className="mb-3 flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-violet-400 to-cyan-400 text-slate-900 font-bold">N</span> Nexus
          </div>
          {FILTERS.map(f => (
            <button key={f.label} onClick={() => s.setFilter(f.kind)}
              className={`rounded-xl px-3 py-2 text-left text-sm transition ${s.filter.kind === f.kind && !s.filter.foldersOnly ? 'bg-white/20' : 'hover:bg-white/10'}`}>{f.label}</button>
          ))}
          <button onClick={s.showFolders} className={`rounded-xl px-3 py-2 text-left text-sm transition ${s.filter.foldersOnly ? 'bg-white/20' : 'hover:bg-white/10'}`}>Folders</button>

          <div className="mt-auto space-y-2 text-xs text-white/70">
            <HealthRow label="Voice" ok={s.health.voice} reason={s.healthReason.voice} />
            <HealthRow label="Gesture" ok={s.health.gesture} reason={s.healthReason.gesture} extra={s.health.gesture ? s.gesture : undefined} />
            <button onClick={onAddFiles} className="w-full rounded-xl bg-white/15 py-2 text-sm font-medium hover:bg-white/25 transition">➕ Add files</button>
            <button onClick={onOpenFolder} className="w-full rounded-xl bg-gradient-to-r from-violet-500/60 to-cyan-500/60 py-2 text-sm font-medium hover:brightness-110 transition">📂 Open folder…</button>
            <button onClick={onEnableHandsFree} className="w-full rounded-xl bg-white/15 py-2 text-sm font-medium hover:bg-white/25 transition">Enable hands-free</button>
            <button onClick={onCalibrate} className="w-full rounded-xl border border-white/20 py-2 text-sm hover:bg-white/10 transition">Calibrate</button>
            {calibrationMsg && <p className="nx-pop rounded-lg bg-black/30 p-2 leading-snug">{calibrationMsg}</p>}
          </div>
        </aside>

        {/* ---- main */}
        <main className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Main Top Header */}
          <header className="glass flex items-center gap-3 rounded-3xl px-4 py-3">
            <button onClick={s.back} className="rounded-lg px-2 py-1 hover:bg-white/10" title="Back (Backspace / swipe left-to-right)">←</button>
            <button onClick={s.forward} className="rounded-lg px-2 py-1 hover:bg-white/10" title="Forward (swipe right-to-left)">→</button>
            <form className="flex-1" onSubmit={e => { e.preventDefault(); if (query.trim()) onSearch(query.trim()); else s.showAll(); }}>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder='Search by meaning — "the resume I edited last week"'
                className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-2 text-sm outline-none placeholder:text-white/40 focus:border-cyan-300/60" />
            </form>
            <button onClick={() => useStore.setState(st => ({ view: st.view === 'grid' ? 'list' : 'grid' }))} className="rounded-lg px-3 py-1 text-sm hover:bg-white/10">{s.view === 'grid' ? '☰ List' : '▦ Grid'}</button>
            <button onClick={() => s.setSort(s.sort === 'name' ? 'recent' : 'name')} title="Sort order" className="rounded-lg px-3 py-1 text-sm hover:bg-white/10">{s.sort === 'recent' ? '🕒 Recent' : 'A–Z'}</button>
            <span className="w-14 text-right text-xs text-white/60">{Math.round((s.openId ? s.docZoom : s.zoom) * 100)}%</span>
            <button onClick={() => setHelp(true)} title="Gestures & voice commands (?)" className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-sm hover:bg-white/25">?</button>
          </header>

          {/* File Operations Toolbar */}
          <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-xs">
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setModalType('new-folder'); setModalInput(''); }}
                title="Create a new folder (Voice: 'create folder <name>')"
                className="flex items-center gap-1 rounded-xl bg-white/10 px-3 py-1.5 hover:bg-white/20 transition"
              >
                📁 New Folder
              </button>
              <button
                disabled={!selectedFile}
                onClick={() => { if (selectedFile) { setModalType('rename'); setModalInput(selectedFile.name); } }}
                title="Rename selected item (Voice: 'rename file to <name>')"
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 transition ${selectedFile ? 'bg-white/10 hover:bg-white/20 text-white' : 'opacity-40 cursor-not-allowed'}`}
              >
                ✏️ Rename
              </button>
              <button
                disabled={!selectedFile}
                onClick={() => s.copyFile()}
                title="Copy selected item (Voice: 'copy file')"
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 transition ${selectedFile ? 'bg-white/10 hover:bg-white/20 text-white' : 'opacity-40 cursor-not-allowed'}`}
              >
                📋 Copy
              </button>
              {s.clipboardId && (
                <button
                  onClick={() => s.pasteFile()}
                  title="Paste clipboard item into current folder"
                  className="flex items-center gap-1 rounded-xl bg-cyan-400/20 text-cyan-200 border border-cyan-300/40 px-3 py-1.5 hover:bg-cyan-400/30 transition"
                >
                  📥 Paste
                </button>
              )}
              <button
                disabled={!selectedFile}
                onClick={() => { if (selectedFile) { setModalType('move'); setModalInput(''); } }}
                title="Move file to folder (Voice: 'move file to <folder>')"
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 transition ${selectedFile ? 'bg-white/10 hover:bg-white/20 text-white' : 'opacity-40 cursor-not-allowed'}`}
              >
                📂 Move To…
              </button>
              <button
                disabled={!selectedFile}
                onClick={() => s.deleteFile()}
                title="Delete selected item (Voice: 'delete file')"
                className={`flex items-center gap-1 rounded-xl px-3 py-1.5 transition ${selectedFile ? 'bg-rose-500/20 text-rose-300 border border-rose-400/30 hover:bg-rose-500/30' : 'opacity-40 cursor-not-allowed'}`}
              >
                🗑️ Delete
              </button>
            </div>

            {/* Gesture state indicator */}
            {s.gesture === 'paused' && (
              <span className="rounded-full bg-amber-400/20 border border-amber-300/40 px-3 py-1 text-amber-200 font-medium nx-pop">
                ✋ Gestures Paused (Show open palm to resume)
              </span>
            )}
            {selectedFile && (
              <span className="text-white/60 truncate max-w-xs">
                Selected: <span className="text-cyan-200 font-medium">{selectedFile.name}</span>
              </span>
            )}
          </div>

          {s.searchIds && <p className="px-2 text-sm text-cyan-200/90">{s.searchIds.length} semantic match{s.searchIds.length === 1 ? '' : 'es'} {s.searchNote && `· ${s.searchNote}`}</p>}

          {/* scrollable file area — gestures scroll THIS element */}
          <section data-nexus-scroll className="glass relative min-h-0 flex-1 overflow-y-auto rounded-3xl p-5">
            {s.files.length === 0
              ? <EmptyState onAddFiles={onAddFiles} onOpenFolder={onOpenFolder} onDemo={s.loadDemo} />
              : list.length === 0 && <p className="mt-20 text-center text-white/50">Nothing here.</p>}
            <div data-grid className={s.view === 'grid' ? 'grid gap-4' : 'flex flex-col gap-2'}
              style={s.view === 'grid' ? { gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(170 * s.zoom)}px, 1fr))` } : undefined}>
              {s.files.length > 0 && s.folderId === null && !s.searchIds && !s.filter.kind && !s.filter.foldersOnly &&
                <AddCard grid={s.view === 'grid'} onClick={onAddFiles} />}
              {list.map((f, i) => <FileCard key={f.id} f={f} index={i + 1} grid={s.view === 'grid'} zoom={s.zoom}
                selected={s.selectedId === f.id} />)}
            </div>
            {scrollDir && <div className="pointer-events-none sticky bottom-2 mx-auto w-fit rounded-full bg-white/20 px-3 py-1 text-sm backdrop-blur nx-pop">{scrollDir === 'up' ? '↑ scrolling' : '↓ scrolling'}</div>}
          </section>

          <footer className="px-2 text-xs text-white/45 flex items-center justify-between">
            <span>
              Voice: “Open the file” · “Go to page 8” · “Create folder” · “Rename” · “Delete” · “Next page” · “Hey Nexus”
            </span>
            <span>
              Gestures: Pinch & release to click · Swipe left/right for next/prev · Swipe up/down to scroll · Palm to pause
            </span>
          </footer>
        </main>
      </div>

      {/* ---- File Action Modals */}
      {modalType && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={() => setModalType(null)}>
          <div className="glass nx-pop w-[min(28rem,90vw)] rounded-3xl p-6" onClick={e => e.stopPropagation()}>
            <h3 className="mb-3 text-lg font-semibold text-cyan-200">
              {modalType === 'new-folder' && '📁 Create New Folder'}
              {modalType === 'rename' && '✏️ Rename Item'}
              {modalType === 'move' && '📂 Move to Folder'}
            </h3>
            <form onSubmit={handleModalSubmit} className="space-y-4">
              <input
                autoFocus
                value={modalInput}
                onChange={e => setModalInput(e.target.value)}
                placeholder={
                  modalType === 'new-folder' ? 'Folder name (e.g. Invoices)' :
                  modalType === 'rename' ? 'New filename' :
                  'Target folder name (e.g. Projects)'
                }
                className="w-full rounded-xl border border-white/20 bg-black/40 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-300"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setModalType(null)} className="rounded-xl px-4 py-2 text-sm text-white/70 hover:bg-white/10">
                  Cancel
                </button>
                <button type="submit" className="rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-5 py-2 text-sm font-medium hover:brightness-110">
                  Confirm
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- listening ring + transcript */}
      {s.wakeActive && (
        <div className="pointer-events-none absolute bottom-10 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-3">
          <div className="relative grid h-20 w-20 place-items-center">
            <span className="nx-ring absolute inset-0 rounded-full border-2 border-cyan-300/80" />
            <span className="nx-ring absolute inset-2 rounded-full border border-violet-300/70" style={{ animationDelay: '.3s' }} />
            <span className="relative grid h-10 w-10 place-items-center rounded-full bg-gradient-to-br from-cyan-300 to-violet-400 text-slate-900">🎙️</span>
          </div>
          <div className="glass nx-pop min-w-[12rem] rounded-full px-5 py-2 text-center text-sm">{s.transcript || 'Listening…'}</div>
        </div>
      )}
      {!s.wakeActive && s.transcript && <div className="glass pointer-events-none absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-full px-5 py-2 text-sm nx-pop">{s.transcript}</div>}

      {/* ---- air-click ripples */}
      {ripples.map(r => (
        <span key={r.id} className="nx-ripple pointer-events-none absolute z-40 h-40 w-40 rounded-full border-2 border-cyan-300 bg-cyan-300/20"
          style={{ left: r.x, top: r.y }} />
      ))}

      {/* ---- hand cursor (positioned imperatively for 60 FPS) */}
      {dbg && <div className="pointer-events-none fixed bottom-2 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-black/70 px-3 py-1 font-mono text-xs text-cyan-200">🖐 {dbg}</div>}
      <div ref={cursorRef} className="pointer-events-none absolute left-0 top-0 z-50 h-8 w-8 rounded-full border-2 border-white bg-white/25 opacity-0 shadow-[0_0_24px_rgba(125,211,252,.9)] backdrop-blur-sm transition-[opacity,scale] duration-150 will-change-transform" />

      {/* ---- opened file */}
      {open && <Preview f={open} onClose={s.close} />}
      {help && <HelpPanel onClose={() => setHelp(false)} />}

      {/* ---- toasts */}
      <div className="pointer-events-none absolute right-5 top-5 z-50 flex flex-col gap-2">
        {s.toasts.map(t => (
          <div key={t.id} className={`glass nx-pop rounded-2xl px-4 py-2 text-sm ${t.tone === 'warn' ? 'border-amber-300/50' : t.tone === 'ok' ? 'border-emerald-300/50' : ''}`}>{t.text}</div>
        ))}
      </div>
      <style>{`[data-hover="1"]{outline:2px solid rgba(125,211,252,.9);transform:translateY(-2px) scale(1.02)}`}</style>
    </div>
  );
}

function AddCard({ grid, onClick }: { grid: boolean; onClick(): void }) {
  return (
    <button onClick={onClick} className={`group grid place-items-center rounded-2xl border-2 border-dashed border-white/25 text-white/60 transition hover:border-cyan-300/70 hover:bg-white/5 hover:text-white ${grid ? 'min-h-[11rem] p-4' : 'px-4 py-3'}`}>
      <div className="text-center"><div className="text-4xl leading-none">＋</div><div className="mt-2 text-sm font-medium">Add files</div><div className="text-xs text-white/40">or drop them here</div></div>
    </button>
  );
}

function EmptyState({ onAddFiles, onOpenFolder, onDemo }: { onAddFiles(): void; onOpenFolder(): void; onDemo(): void }) {
  return (
    <div className="mx-auto mt-16 max-w-xl text-center">
      <button onClick={onAddFiles} className="mx-auto mb-5 grid h-28 w-28 place-items-center rounded-3xl border-2 border-dashed border-cyan-300/60 text-6xl text-cyan-200 transition hover:bg-cyan-300/10">＋</button>
      <h2 className="text-xl font-semibold">Add your files</h2>
      <p className="mt-2 text-sm text-white/55">Pick files from File Explorer, drag files or folders onto this window, or open a whole folder.</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button onClick={onAddFiles} className="rounded-xl bg-white/15 px-5 py-2 text-sm font-medium hover:bg-white/25 transition">➕ Add files</button>
        <button onClick={onOpenFolder} className="rounded-xl bg-gradient-to-r from-violet-500/60 to-cyan-500/60 px-5 py-2 text-sm font-medium hover:brightness-110 transition">📂 Open folder</button>
        <button onClick={onDemo} className="rounded-xl border border-white/20 px-5 py-2 text-sm text-white/70 hover:bg-white/10 transition">Load demo files</button>
      </div>
    </div>
  );
}

function FileCard({ f, index, grid, zoom, selected }: { f: FileItem; index: number; grid: boolean; zoom: number; selected: boolean }) {
  const st = KIND_STYLE[f.kind];
  const store = useStore.getState;
  return (
    <button data-file-id={f.id} onClick={() => store().select(f.id)} onDoubleClick={() => store().open({ by: 'file', fileId: f.id })}
      className={`group relative overflow-hidden rounded-2xl border text-left transition duration-200 hover:-translate-y-0.5 ${selected ? 'border-cyan-300/80 bg-white/20 shadow-[0_0_30px_rgba(103,232,249,.35)]' : 'border-white/10 bg-white/[0.06] hover:bg-white/10'} ${grid ? 'p-4' : 'flex items-center gap-4 px-4 py-3'}`}>
      <span className="absolute right-2 top-2 rounded-full bg-black/30 px-2 text-[10px] text-white/60">{index}</span>
      <div className={`grid place-items-center rounded-xl bg-gradient-to-br ${st.grad} ${grid ? 'mb-3 aspect-[4/3]' : 'h-12 w-12'}`} style={grid ? { fontSize: 38 * zoom } : undefined}>{st.icon}</div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{f.name}</div>
        <div className="mt-0.5 text-xs text-white/50">{f.size} · {fmt(f.modified)}</div>
        {f.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{f.tags.map(t => <span key={t} className="rounded-full bg-violet-400/25 px-2 py-0.5 text-[10px] text-violet-100">✦ {t}</span>)}</div>}
      </div>
    </button>
  );
}

type Content =
  | { type: 'text'; text: string } | { type: 'img'; url: string } | { type: 'pdf'; doc: any }
  | { type: 'html'; html: string } | { type: 'pptx'; slides: { paras: string[]; images: string[] }[] }
  | { type: 'note'; note: string };

function Preview({ f, onClose }: { f: FileItem; onClose(): void }) {
  const [c, setC] = useState<Content | null>(null);
  const z = useStore(st => st.docZoom);
  useEffect(() => {
    let urls: string[] = [], dead = false;
    setC(null);
    (async () => {
      const h = getHandle(f.id);
      if (!h) return setC({ type: 'note', note: f.snippet });
      const file: File = await h.getFile();
      const ext = f.name.split('.').pop()!.toLowerCase();
      if (f.kind === 'image') { const url = URL.createObjectURL(file); urls.push(url); if (!dead) setC({ type: 'img', url }); }
      else if (f.kind === 'pdf') { const doc = await loadPdf(file); if (!dead) setC({ type: 'pdf', doc }); }
      else if (f.kind === 'docx') {
        if (ext !== 'docx') return setC({ type: 'note', note: 'Old .doc files are not supported. Save the file as .docx and try again.' });
        const html = await loadDocx(file); if (!dead) setC({ type: 'html', html });
      } else if (f.kind === 'slides') {
        if (ext !== 'pptx') return setC({ type: 'note', note: 'Old .ppt files are not supported. Save the file as .pptx and try again.' });
        const p = await loadPptx(file); urls = p.urls; if (!dead) setC({ type: 'pptx', slides: p.slides });
      } else if (f.kind === 'txt' || f.kind === 'code') { const text = await file.slice(0, 200000).text(); if (!dead) setC({ type: 'text', text }); }
      else setC({ type: 'note', note: 'Preview for this file type is not available yet.' });
    })().catch(e => !dead && setC({ type: 'note', note: `Could not open this file: ${e.message}` }));
    return () => { dead = true; urls.forEach(u => URL.revokeObjectURL(u)); };
  }, [f.id]);

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-black/55 backdrop-blur-sm" onClick={onClose}>
      <div className="glass nx-pop flex max-h-[92vh] w-[min(68rem,95vw)] flex-col rounded-3xl p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center gap-3">
          <span className="text-4xl">{KIND_STYLE[f.kind].icon}</span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-semibold">{f.name}</h2>
            <p className="text-sm text-white/55">{f.size} · modified {fmt(f.modified, true)}</p>
          </div>
          <span className="rounded-full bg-white/15 px-3 py-1 text-xs">🔍 {Math.round(z * 100)}%</span>
        </div>

        <div data-nexus-scroll className="min-h-[16rem] flex-1 overflow-auto rounded-2xl bg-black/25 p-4">
          {!c && <p className="text-white/50">Loading…</p>}
          {c?.type === 'text' && <pre style={{ fontSize: 13 * z }} className="whitespace-pre-wrap break-words font-mono leading-relaxed text-white/85">{c.text}</pre>}
          {c?.type === 'img' && <img src={c.url} alt={f.name} style={{ width: `${z * 100}%`, maxWidth: 'none' }} className="mx-auto rounded-xl" />}
          {c?.type === 'pdf' && <PdfView doc={c.doc} zoom={z} />}
          {c?.type === 'html' && <div style={{ zoom: z } as any} className="mx-auto max-w-3xl rounded-xl bg-white p-8 text-sm leading-relaxed text-slate-900 [&_img]:max-w-full [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_p]:mb-3 [&_table]:border [&_td]:border [&_td]:p-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6" dangerouslySetInnerHTML={{ __html: c.html }} />}
          {c?.type === 'pptx' && (
            <div style={{ zoom: z } as any} className="mx-auto max-w-3xl space-y-5">
              {c.slides.map((sl, i) => (
                <div key={i} className="rounded-2xl border border-white/15 bg-white/[0.07] p-6 shadow-lg">
                  <div className="mb-3 flex justify-between text-[11px] uppercase tracking-widest text-white/40"><span>Slide {i + 1}</span><span>{i + 1} / {c.slides.length}</span></div>
                  {sl.paras.length === 0 && sl.images.length === 0 && <p className="text-sm italic text-white/40">(empty slide)</p>}
                  {sl.paras[0] && <h3 className="mb-2 text-2xl font-semibold leading-snug">{sl.paras[0]}</h3>}
                  {sl.paras.length > 1 && <ul className="list-disc space-y-1 pl-6 text-base text-white/85">{sl.paras.slice(1).map((t, j) => <li key={j}>{t}</li>)}</ul>}
                  {sl.images.length > 0 && <div className={`mt-4 grid gap-3 ${sl.images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {sl.images.map((u, k) => <img key={k} src={u} className="max-h-96 w-full rounded-xl bg-white/10 object-contain" />)}</div>}
                </div>
              ))}
            </div>
          )}
          {c?.type === 'note' && <p className="text-sm text-white/75">{c.note}</p>}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-white/50">
          <span>“go to page 8” · “next page” · “zoom in/out” · swipe left/right · Esc / “close it”</span>
          <button onClick={onClose} className="rounded-xl bg-white/15 px-4 py-2 text-sm text-white hover:bg-white/25 transition">Close</button>
        </div>
      </div>
    </div>
  );
}

const HELP_GESTURES: [string, string, string][] = [
  ['🤏 Quick Pinch + Release', 'Select or Click / Open', 'Click where cursor is; quick tap selects, double tap opens'],
  ['👋 Swipe Right-to-Left', 'Next Page / Next Item', 'Turns to next PDF page or moves to next file'],
  ['👋 Swipe Left-to-Right', 'Previous Page / Previous Item / Back', 'Turns to previous PDF page or goes back'],
  ['👆 Swipe Up', 'Scroll Up', 'Scrolls document or file grid upward'],
  ['👇 Swipe Down', 'Scroll Down', 'Scrolls document or file grid downward'],
  ['🤙 Two-Finger Spread / Pinch', 'Zoom In / Zoom Out', 'Spread thumb & index apart to zoom in; pinch closer to zoom out'],
  ['✋ Open Palm (Hold)', 'Pause / Resume Recognition', 'Hold flat open palm facing camera to freeze/unfreeze gestures'],
  ['✊ Fist (~⅓ s)', 'Disengage / Turn Off', 'Releases gesture tracking when finished'],
];

const HELP_VOICE: [string, string][] = [
  ['“Hey Nexus”', 'Wake phrase. Opens 30s session to chain commands without re-waking'],
  ['“Open the file”  ·  “Show me the document”  ·  “Display this file”  ·  “Launch the document”', 'Open selected item or document'],
  ['“Open resume”  ·  “Open third file”  ·  “Open number 2”', 'Open file by name or numbered position'],
  ['“Close file”  ·  “Close it”  ·  “Exit preview”', 'Close active document preview'],
  ['“Go to page eight”  ·  “Open the 8th page”  ·  “Show page number 8”', 'Jump directly to specified PDF page'],
  ['“Open the first page”  ·  “Start from the beginning”  ·  “Go to starting page”', 'Navigate to page 1 of document'],
  ['“Open the last page”  ·  “Jump to the end”  ·  “Go to final page”', 'Navigate to final page of document'],
  ['“Next page”  ·  “Previous page”  ·  “Move forward 2 pages”  ·  “Go back 3 pages”', 'Relative page navigation'],
  ['“Jump to the middle of the document”', 'Navigate halfway through the document'],
  ['“Create folder <name>”  ·  “New folder Work”', 'Create a new directory in current folder'],
  ['“Rename file to <name>”  ·  “Change name to report”', 'Rename the selected item'],
  ['“Delete file”  ·  “Remove document”', 'Delete selected item'],
  ['“Copy file”  ·  “Move file to <folder>”', 'Copy or move file to target destination'],
  ['“Scroll up”  ·  “Scroll down”  ·  “Zoom in”  ·  “Zoom out”  ·  “Reset zoom”', 'Viewport zoom and scrolling'],
  ['“Search for <query>”  ·  “Find documents about budget”', 'MiniLM semantic search by meaning'],
];

function HelpPanel({ onClose }: { onClose(): void }) {
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="glass nx-pop max-h-[92vh] w-[min(62rem,95vw)] overflow-auto rounded-3xl p-6" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-cyan-200">Gestures & Natural Voice Commands</h2>
          <button onClick={onClose} className="rounded-xl bg-white/15 px-3 py-1 text-sm hover:bg-white/25">Close (Esc)</button>
        </div>
        <h3 className="mb-2 text-sm font-semibold text-cyan-200">✋ Hand Gestures</h3>
        <table className="mb-6 w-full text-left text-sm">
          <tbody>
            {HELP_GESTURES.map(([g, a, u]) => (
              <tr key={g} className="border-t border-white/10 align-top">
                <td className="py-2 pr-4 font-medium text-white">{g}</td>
                <td className="py-2 pr-4 text-cyan-200">{a}</td>
                <td className="py-2 text-white/60">{u}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="mb-2 text-sm font-semibold text-cyan-200">🎙️ Natural Voice Commands (Say “Hey Nexus” first)</h3>
        <table className="w-full text-left text-sm">
          <tbody>
            {HELP_VOICE.map(([c, u]) => (
              <tr key={c} className="border-t border-white/10 align-top">
                <td className="py-2 pr-4 font-mono text-xs text-white/90">{c}</td>
                <td className="py-2 text-white/60">{u}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-white/45">Keyboard shortcuts: arrows navigate · Enter opens · Delete deletes · Esc closes · + / − zoom · ? help</p>
      </div>
    </div>
  );
}

function HealthRow({ label, ok, extra, reason }: { label: string; ok: boolean | null; extra?: string; reason?: string }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className={`flex items-center gap-1.5 ${ok === null ? 'text-white/40' : ok ? 'text-emerald-300' : 'text-amber-300'}`}>
          <i className={`h-2 w-2 rounded-full ${ok === null ? 'bg-white/30' : ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          {ok === null ? 'off' : ok ? (extra ?? 'on') : 'fallback'}
        </span>
      </div>
      {ok === false && reason && (
        <p title={reason} className="mt-1 line-clamp-3 break-words rounded-lg bg-amber-400/10 p-1.5 text-[10px] leading-snug text-amber-200">
          {reason}
        </p>
      )}
    </div>
  );
}