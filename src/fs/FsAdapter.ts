/**
 * Real file access via the browser File System Access API (Chrome/Edge, localhost or https).
 * Three ways in: pick a folder, pick files (dialog starts in Downloads), or drag-and-drop
 * files/folders from File Explorer. Everything is read locally; nothing leaves the machine.
 * (In the Electron build this same interface can be backed by Node's fs through IPC.)
 */
import type { FileItem, Kind } from '../state/store';

const handles = new Map<string, any>();            // file id -> FileSystemFileHandle
export const getHandle = (id: string) => handles.get(id);
let seq = 0;

const MAX_ITEMS = 3000, MAX_DEPTH = 6;
const SKIP = new Set(['node_modules', '__pycache__', 'dist', 'build', 'venv', '.git', '$RECYCLE.BIN', 'System Volume Information']);
const TEXTY = new Set(['txt', 'md', 'csv', 'log', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'html', 'css', 'sql', 'sh', 'yml', 'yaml', 'xml', 'ini']);
const KINDS: Record<string, Kind> = {
  ppt: 'slides', pptx: 'slides', pdf: 'pdf', doc: 'docx', docx: 'docx', rtf: 'txt', txt: 'txt', md: 'txt', csv: 'txt', log: 'txt',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  js: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code', cs: 'code',
  go: 'code', rs: 'code', rb: 'code', php: 'code', html: 'code', css: 'code', sql: 'code', sh: 'code', json: 'code', yml: 'code', yaml: 'code', xml: 'code',
};
const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
export const kindOf = (name: string): Kind => KINDS[extOf(name)] ?? 'other';

const humanSize = (b: number) => b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(1)} GB`;

export interface ScanResult { files: FileItem[]; rootName: string; truncated: boolean }
interface Ctx { files: FileItem[]; truncated: boolean }

async function readFileItem(entry: any, id: string, parentId: string | null): Promise<FileItem | null> {
  try {
    const file: File = await entry.getFile();
    handles.set(id, entry);
    let snippet = '';
    if (TEXTY.has(extOf(entry.name)) && file.size < 2_000_000) {
      snippet = (await file.slice(0, 1200).text()).replace(/\s+/g, ' ').trim().slice(0, 400);
    }
    return { id, name: entry.name, kind: kindOf(entry.name), parentId, modified: file.lastModified, size: humanSize(file.size), snippet: snippet || entry.name, tags: [] };
  } catch { return null; }                          // unreadable file: skip
}

/** Walk one directory; returns the newest modified time inside it (used as the folder's date). */
async function walk(ctx: Ctx, dir: any, path: string, depth: number): Promise<number> {
  let newest = 0;
  for await (const entry of dir.values()) {
    if (ctx.files.length >= MAX_ITEMS) { ctx.truncated = true; break; }
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const id = path ? `${path}/${entry.name}` : entry.name;
    const parentId = path || null;
    if (entry.kind === 'directory') {
      if (depth >= MAX_DEPTH) continue;
      const item: FileItem = { id, name: entry.name, kind: 'folder', parentId, modified: 0, size: '—', snippet: `folder ${entry.name}`, tags: [] };
      ctx.files.push(item);
      item.modified = await walk(ctx, entry, id, depth + 1);
      newest = Math.max(newest, item.modified);
    } else {
      const item = await readFileItem(entry, id, parentId);
      if (item) { ctx.files.push(item); newest = Math.max(newest, item.modified); }
    }
  }
  return newest;
}

/** Replace-mode scan of a whole folder (its children become the top level). */
export async function scanDirectory(root: any): Promise<ScanResult> {
  handles.clear();
  const ctx: Ctx = { files: [], truncated: false };
  await walk(ctx, root, '', 0);
  return { files: ctx.files, rootName: root.name, truncated: ctx.truncated };
}

/** Append-mode: individual file handles and/or folder handles (from the picker or a drop). */
export async function ingestHandles(hs: any[]): Promise<{ files: FileItem[]; truncated: boolean }> {
  const ctx: Ctx = { files: [], truncated: false };
  for (const h of hs) {
    const id = `${h.name}#${++seq}`;                // unique even if the same name is added twice
    if (h.kind === 'directory') {
      const item: FileItem = { id, name: h.name, kind: 'folder', parentId: null, modified: 0, size: '—', snippet: `folder ${h.name}`, tags: [] };
      ctx.files.push(item);
      item.modified = await walk(ctx, h, id, 0);
    } else {
      const item = await readFileItem(h, id, null);
      if (item) ctx.files.push(item);
    }
  }
  return ctx;
}

/** Show Chrome's folder picker, then scan. Returns null if the user cancels. */
export async function pickAndScan(): Promise<ScanResult | null> {
  if (!(window as any).showDirectoryPicker) throw new Error('This browser cannot open folders - use Chrome or Edge');
  try { return await scanDirectory(await (window as any).showDirectoryPicker({ mode: 'read' })); }
  catch (e) { if ((e as Error).name === 'AbortError') return null; throw e; }
}

/**
 * Multi-file picker. The dialog opens in the Downloads folder (Chrome does not allow picking the
 * Downloads FOLDER itself, but it does allow picking files from it - Ctrl+A selects them all).
 */
export async function pickFiles(): Promise<any[]> {
  const w = window as any;
  if (!w.showOpenFilePicker) throw new Error('This browser cannot add files this way - use Chrome or Edge');
  try { return await w.showOpenFilePicker({ multiple: true, startIn: 'downloads' }); }
  catch (e) { if ((e as Error).name === 'AbortError') return []; throw e; }
}
