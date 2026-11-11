/**
 * Zustand store = single source of truth. Voice, gesture, keyboard and mouse all
 * call the SAME actions, so every input modality behaves identically and a failed
 * modality can never put the UI in a different state.
 */
import { create } from 'zustand';
import type { Command, FileTarget } from '../shared/bus';
import { norm } from '../voice/CommandParser';

export type Kind = 'folder' | 'pdf' | 'docx' | 'slides' | 'txt' | 'image' | 'code' | 'other';
export interface FileItem {
  id: string; name: string; kind: Kind; parentId: string | null;
  modified: number; size: string; snippet: string; tags: string[];
}

const D = 86_400_000, now = Date.now();
export const MOCK_FILES: FileItem[] = [
  { id: 'f1', name: 'Projects', kind: 'folder', parentId: null, modified: now - 9 * D, size: '—', snippet: 'project folders', tags: [] },
  { id: 'f2', name: 'Photos', kind: 'folder', parentId: null, modified: now - 20 * D, size: '—', snippet: 'pictures', tags: [] },
  { id: 'd1', name: 'Resume_2026.pdf', kind: 'pdf', parentId: null, modified: now - 4 * D, size: '212 KB', snippet: 'Curriculum vitae: software engineer, 5 years experience, skills in React and Python', tags: [] },
  { id: 'd2', name: 'Marketing_Plan_Q3.docx', kind: 'docx', parentId: null, modified: now - 2 * D, size: '88 KB', snippet: 'Marketing campaign plan for Q3 product launch, audience, channels, social media budget', tags: [] },
  { id: 'd3', name: 'Budget_2026.txt', kind: 'txt', parentId: null, modified: now - 12 * D, size: '4 KB', snippet: 'Annual budget expenses revenue forecast finance', tags: [] },
  { id: 'd4', name: 'Team_Meeting_Notes.txt', kind: 'txt', parentId: null, modified: now - 1 * D, size: '9 KB', snippet: 'Meeting notes: action items, ideas, minutes from the weekly sync', tags: [] },
  { id: 'd5', name: 'beach_sunset.png', kind: 'image', parentId: 'f2', modified: now - 30 * D, size: '3.4 MB', snippet: 'photo of sunset at the beach', tags: [] },
  { id: 'd6', name: 'App.tsx', kind: 'code', parentId: 'f1', modified: now - 3 * D, size: '12 KB', snippet: 'React component source code typescript', tags: [] },
  { id: 'd7', name: 'Research_Paper_Draft.docx', kind: 'docx', parentId: 'f1', modified: now - 8 * D, size: '540 KB', snippet: 'Research paper draft: abstract, methodology, results and references', tags: [] },
  { id: 'd8', name: 'Lease_Agreement.pdf', kind: 'pdf', parentId: null, modified: now - 40 * D, size: '1.1 MB', snippet: 'Rental contract agreement terms and conditions', tags: [] },
  { id: 'd9', name: 'server.py', kind: 'code', parentId: 'f1', modified: now - 6 * D, size: '7 KB', snippet: 'python api server script', tags: [] },
  { id: 'd10', name: 'Marketing_Budget.txt', kind: 'txt', parentId: null, modified: now - 5 * D, size: '3 KB', snippet: 'Marketing spend per channel, advertising budget', tags: [] },
];

interface Toast { id: number; text: string; tone: 'info' | 'warn' | 'ok' }

export interface State {
  files: FileItem[];
  folderId: string | null;
  history: (string | null)[]; cursor: number;       // folder navigation history
  filter: { kind: Kind | null; foldersOnly: boolean };
  searchIds: string[] | null; searchNote: string;
  selectedId: string | null; openId: string | null;
  view: 'grid' | 'list'; zoom: number; docZoom: number;   // zoom = file grid, docZoom = the OPEN document
  wakeActive: boolean; transcript: string;
  gesture: 'idle' | 'arming' | 'engaged' | 'paused';
  health: { gesture: boolean | null; voice: boolean | null };
  healthReason: { gesture: string; voice: string };
  sort: 'name' | 'recent';
  toasts: Toast[];

  // PDF Page navigation state
  pdfCurrentPage: number;
  pdfTotalPages: number;

  // File clipboard & action state
  clipboardId: string | null;
  clipboardOp: 'copy' | 'move' | null;

  select(id: string | null): void;
  open(t: FileTarget): void;
  close(): void;
  back(): void; forward(): void;
  enterFolder(id: string | null): void;
  showFolders(): void; showAll(): void;
  setFilter(kind: Kind | null): void;
  zoomBy(factor: number): void;
  setSearch(ids: string[] | null, note?: string): void;
  setTags(t: Record<string, string[]>): void;
  loadFiles(files: FileItem[]): void;
  addFiles(files: FileItem[]): void;
  loadDemo(): void;
  setSort(s: 'name' | 'recent'): void;

  // Complete file management
  createFolder(name?: string): void;
  renameFile(targetId?: string, newName?: string): void;
  deleteFile(targetId?: string): void;
  copyFile(targetId?: string): void;
  moveFile(targetId?: string, destinationFolderName?: string): void;
  pasteFile(): void;

  // PDF navigation
  pdfSetPage(page: number): void;
  pdfSetTotalPages(total: number): void;
  pdfNav(mode: number | 'next' | 'prev' | 'first' | 'last' | 'middle', delta?: number): void;

  run(c: Command): void;
  toast(text: string, tone?: Toast['tone']): void;
  set(p: Partial<State>): void;
}

/** What is on screen right now (filters + search + folder). Ordinals refer to THIS list. */
export function visibleFiles(s: Pick<State, 'files' | 'folderId' | 'filter' | 'searchIds' | 'sort'>): FileItem[] {
  if (s.searchIds) return s.searchIds.map(id => s.files.find(f => f.id === id)!).filter(Boolean);
  let list = s.files.filter(f => f.parentId === s.folderId);
  if (s.filter.foldersOnly) list = s.files.filter(f => f.kind === 'folder');
  if (s.filter.kind) list = s.files.filter(f => f.kind === s.filter.kind);
  return list.sort((a, b) => (a.kind === 'folder' ? -1 : 0) - (b.kind === 'folder' ? -1 : 0) || (s.sort === 'recent' ? b.modified - a.modified : a.name.localeCompare(b.name)));
}

export function resolveFileTarget(t: FileTarget, s: State): FileItem | undefined {
  const list = visibleFiles(s);
  if (t.by === 'file') return s.files.find(x => x.id === t.fileId);
  if (t.by === 'index') return list.at(t.index > 0 ? t.index - 1 : t.index);
  if (t.by === 'selection') return s.files.find(x => x.id === s.selectedId);
  if (t.by === 'name') {
    const targetNorm = norm(t.name);
    return s.files.find(x => norm(x.name) === targetNorm) ||
           list.find(x => norm(x.name).includes(targetNorm));
  }
  return undefined;
}

let toastSeq = 0;
export const useStore = create<State>((set, get) => ({
  files: [], folderId: null, history: [null], cursor: 0,
  filter: { kind: null, foldersOnly: false }, searchIds: null, searchNote: '',
  selectedId: null, openId: null, view: 'grid', zoom: 1, docZoom: 1,
  wakeActive: false, transcript: '', gesture: 'idle',
  health: { gesture: null, voice: null }, healthReason: { gesture: '', voice: '' }, sort: 'name', toasts: [],

  pdfCurrentPage: 1,
  pdfTotalPages: 1,
  clipboardId: null,
  clipboardOp: null,

  set: (p) => set(p),
  select: (id) => set({ selectedId: id }),

  open: (t) => {
    const s = get();
    const f = resolveFileTarget(t, s);
    if (!f) return get().toast('No such item on screen', 'warn');
    if (f.kind === 'folder') return get().enterFolder(f.id);
    set({ openId: f.id, selectedId: f.id, docZoom: 1, pdfCurrentPage: 1 });
  },
  close: () => set({ openId: null }),

  enterFolder: (id) => {
    const s = get();
    const history = [...s.history.slice(0, s.cursor + 1), id];
    set({ folderId: id, history, cursor: history.length - 1, openId: null, selectedId: null,
          filter: { kind: null, foldersOnly: false }, searchIds: null });
  },
  back: () => {
    const s = get();
    if (s.openId) return set({ openId: null });                  // back closes a file first
    if (s.searchIds) return set({ searchIds: null, searchNote: '' });
    if (s.cursor > 0) set({ cursor: s.cursor - 1, folderId: s.history[s.cursor - 1], selectedId: null });
  },
  forward: () => {
    const s = get();
    if (s.cursor < s.history.length - 1) set({ cursor: s.cursor + 1, folderId: s.history[s.cursor + 1], selectedId: null });
  },
  showFolders: () => set({ filter: { kind: null, foldersOnly: true }, searchIds: null, openId: null }),
  showAll: () => set({ filter: { kind: null, foldersOnly: false }, searchIds: null, searchNote: '', openId: null }),
  setFilter: (kind) => set({ filter: { kind, foldersOnly: false }, searchIds: null, openId: null }),
  zoomBy: (f) => set(s => s.openId
    ? { docZoom: Math.min(4, Math.max(0.5, s.docZoom * f)) }
    : { zoom: Math.min(1.8, Math.max(0.6, s.zoom * f)) }),
  setSearch: (ids, note = '') => set({ searchIds: ids, searchNote: note, openId: null }),
  loadFiles: (files) => set({ files, folderId: null, history: [null], cursor: 0, filter: { kind: null, foldersOnly: false },
    searchIds: null, searchNote: '', selectedId: null, openId: null }),
  addFiles: (items) => set(s => {
    const sig = (f: FileItem) => `${f.parentId}|${f.name}|${f.modified}|${f.size}`;
    const have = new Set(s.files.map(sig));
    return { files: [...s.files, ...items.filter(f => !have.has(sig(f)))], sort: 'recent', folderId: null, history: [null], cursor: 0,
             filter: { kind: null, foldersOnly: false }, searchIds: null, searchNote: '', openId: null };
  }),
  loadDemo: () => get().loadFiles(MOCK_FILES),
  setSort: (sort) => set({ sort }),
  setTags: (t) => set(s => ({ files: s.files.map(f => ({ ...f, tags: t[f.id] ?? f.tags })) })),

  // ---------------------------------------------------------------- File Operations
  createFolder: (name) => {
    const s = get();
    let folderName = (name || 'New Folder').trim();
    const existing = s.files.filter(f => f.parentId === s.folderId && f.name.startsWith(folderName));
    if (existing.length > 0) folderName = `${folderName} (${existing.length + 1})`;

    const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newFolder: FileItem = {
      id,
      name: folderName,
      kind: 'folder',
      parentId: s.folderId,
      modified: Date.now(),
      size: '—',
      snippet: `folder ${folderName}`,
      tags: [],
    };
    set({ files: [newFolder, ...s.files], selectedId: id });
    s.toast(`📁 Folder "${folderName}" created`, 'ok');
  },

  renameFile: (targetId, newName) => {
    const s = get();
    const id = targetId || s.selectedId;
    if (!id) return s.toast('No item selected to rename', 'warn');
    const f = s.files.find(x => x.id === id);
    if (!f) return s.toast('Item not found', 'warn');
    if (!newName || !newName.trim()) return s.toast('New name cannot be empty', 'warn');

    const cleanName = newName.trim();
    set({
      files: s.files.map(item => item.id === id ? { ...item, name: cleanName, modified: Date.now() } : item),
    });
    s.toast(`✏️ Renamed to "${cleanName}"`, 'ok');
  },

  deleteFile: (targetId) => {
    const s = get();
    const id = targetId || s.selectedId;
    if (!id) return s.toast('No item selected to delete', 'warn');
    const f = s.files.find(x => x.id === id);
    if (!f) return s.toast('Item not found', 'warn');

    // Recursively delete children if it's a folder
    const toDelete = new Set<string>([id]);
    const collectDescendants = (parentId: string) => {
      for (const item of s.files) {
        if (item.parentId === parentId && !toDelete.has(item.id)) {
          toDelete.add(item.id);
          if (item.kind === 'folder') collectDescendants(item.id);
        }
      }
    };
    if (f.kind === 'folder') collectDescendants(id);

    set({
      files: s.files.filter(item => !toDelete.has(item.id)),
      selectedId: s.selectedId === id ? null : s.selectedId,
      openId: s.openId === id ? null : s.openId,
    });
    s.toast(`🗑️ Deleted "${f.name}"`, 'ok');
  },

  copyFile: (targetId) => {
    const s = get();
    const id = targetId || s.selectedId;
    if (!id) return s.toast('No item selected to copy', 'warn');
    const f = s.files.find(x => x.id === id);
    if (!f) return s.toast('Item not found', 'warn');

    set({ clipboardId: id, clipboardOp: 'copy' });
    s.toast(`📋 Copied "${f.name}" to clipboard`, 'info');
  },

  moveFile: (targetId, destinationFolderName) => {
    const s = get();
    const id = targetId || s.selectedId;
    if (!id) return s.toast('No item selected to move', 'warn');
    const f = s.files.find(x => x.id === id);
    if (!f) return s.toast('Item not found', 'warn');

    let destFolderId: string | null = null;
    let destName = 'root';
    if (destinationFolderName && destinationFolderName.trim()) {
      const destTarget = norm(destinationFolderName.trim());
      const dest = s.files.find(x => x.kind === 'folder' && norm(x.name) === destTarget);
      if (!dest) return s.toast(`Destination folder "${destinationFolderName}" not found`, 'warn');
      if (dest.id === f.id) return s.toast('Cannot move a folder into itself', 'warn');
      destFolderId = dest.id;
      destName = dest.name;
    } else {
      destFolderId = s.folderId;
    }

    set({
      files: s.files.map(item => item.id === id ? { ...item, parentId: destFolderId, modified: Date.now() } : item),
    });
    s.toast(`📂 Moved "${f.name}" to "${destName}"`, 'ok');
  },

  pasteFile: () => {
    const s = get();
    if (!s.clipboardId) return s.toast('Clipboard is empty', 'warn');
    const src = s.files.find(x => x.id === s.clipboardId);
    if (!src) return s.toast('Original item not found', 'warn');

    if (s.clipboardOp === 'copy') {
      const copyName = `Copy of ${src.name}`;
      const newId = `f_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const copied: FileItem = {
        ...src,
        id: newId,
        name: copyName,
        parentId: s.folderId,
        modified: Date.now(),
      };
      set({ files: [copied, ...s.files], selectedId: newId });
      s.toast(`📋 Pasted "${copyName}"`, 'ok');
    } else if (s.clipboardOp === 'move') {
      set({
        files: s.files.map(item => item.id === src.id ? { ...item, parentId: s.folderId, modified: Date.now() } : item),
        clipboardId: null,
        clipboardOp: null,
      });
      s.toast(`📂 Moved "${src.name}" here`, 'ok');
    }
  },

  // ---------------------------------------------------------------- PDF Page Navigation
  pdfSetTotalPages: (total) => {
    set({ pdfTotalPages: Math.max(1, total) });
  },

  pdfSetPage: (targetPage) => {
    const s = get();
    const total = s.pdfTotalPages || 1;
    if (targetPage < 1 || targetPage > total) {
      return s.toast(`Cannot navigate to page ${targetPage}. Document has ${total} page${total === 1 ? '' : 's'}.`, 'warn');
    }
    set({ pdfCurrentPage: targetPage });
    window.dispatchEvent(new CustomEvent('nexus:pdf-jump', { detail: { page: targetPage } }));
    s.toast(`📄 Page ${targetPage} of ${total}`, 'info');
  },

  pdfNav: (mode, delta = 1) => {
    const s = get();
    const total = s.pdfTotalPages || 1;
    let target = s.pdfCurrentPage;

    if (typeof mode === 'number') {
      target = mode;
    } else if (mode === 'first') {
      target = 1;
    } else if (mode === 'last') {
      target = total;
    } else if (mode === 'middle') {
      target = Math.max(1, Math.round(total / 2));
    } else if (mode === 'next') {
      target = Math.min(total, s.pdfCurrentPage + delta);
    } else if (mode === 'prev') {
      target = Math.max(1, s.pdfCurrentPage - delta);
    }

    s.pdfSetPage(target);
  },

  // ---------------------------------------------------------------- Dispatcher
  run: (c) => {
    const s = get();
    switch (c.kind) {
      case 'open': return s.open(c.target);
      case 'close': return s.close();
      case 'select': {
        const f = resolveFileTarget(c.target, s);
        if (f) { s.select(f.id); s.toast(`Selected "${f.name}"`, 'info'); }
        else s.toast('No matching item to select', 'warn');
        return;
      }
      case 'create-folder': return s.createFolder(c.name);
      case 'rename': {
        const f = c.target ? resolveFileTarget(c.target, s) : (s.selectedId ? s.files.find(x => x.id === s.selectedId) : undefined);
        return s.renameFile(f?.id, c.newName);
      }
      case 'delete': {
        const f = c.target ? resolveFileTarget(c.target, s) : (s.selectedId ? s.files.find(x => x.id === s.selectedId) : undefined);
        return s.deleteFile(f?.id);
      }
      case 'copy': {
        const f = c.target ? resolveFileTarget(c.target, s) : (s.selectedId ? s.files.find(x => x.id === s.selectedId) : undefined);
        return s.copyFile(f?.id);
      }
      case 'move': {
        const f = c.target ? resolveFileTarget(c.target, s) : (s.selectedId ? s.files.find(x => x.id === s.selectedId) : undefined);
        return s.moveFile(f?.id, c.destination);
      }
      case 'pdf-page': return s.pdfNav(c.page, c.delta);
      case 'pause-gestures': {
        set({ gesture: 'paused' });
        s.toast('Gestures paused (✋ show palm to resume)', 'info');
        return;
      }
      case 'resume-gestures': {
        set({ gesture: 'engaged' });
        s.toast('Gestures resumed', 'ok');
        return;
      }
      case 'sleep': return;
      case 'back': return s.back();
      case 'forward': return s.forward();
      case 'show-folders': return s.showFolders();
      case 'show-all': return s.showAll();
      case 'filter': return s.setFilter(c.ext as Kind);
      case 'zoom': return c.dir === 'reset' ? set(st => (st.openId ? { docZoom: 1 } : { zoom: 1 })) : s.zoomBy(c.dir === 'in' ? 1.25 : 1 / 1.25);
      case 'scroll': return void [...document.querySelectorAll('[data-nexus-scroll]')].at(-1)?.scrollBy({ top: c.dir === 'down' ? 400 : -400, behavior: 'smooth' });
      case 'search': window.dispatchEvent(new CustomEvent('nexus:do-search', { detail: c.query })); return;
    }
  },

  toast: (text, tone = 'info') => {
    const id = ++toastSeq;
    set(s => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
    setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 3500);
  },
}));
