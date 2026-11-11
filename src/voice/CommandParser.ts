/**
 * CommandParser — comprehensive semantic parser for touchless file management.
 *
 * Supports natural sentence structures, synonyms, PDF page navigation,
 * complete file operations (create folder, rename, delete, copy, move),
 * navigation, filtering, scrolling, and zooming.
 */
import type { Command, FileTarget } from '../shared/bus';

export interface NamedFile { id: string; name: string }

export const WAKE_PHRASE = 'hey nexus';

export const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  'twenty one': 21, 'twenty two': 22, 'twenty three': 23, 'twenty four': 24, 'twenty five': 25,
  'twenty six': 26, 'twenty seven': 27, 'twenty eight': 28, 'twenty nine': 29, thirty: 30,
  'thirty one': 31, 'thirty two': 32, 'thirty three': 33, 'thirty four': 34, 'thirty five': 35,
  forty: 40, fifty: 50,
};

export const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  'twenty first': 21, 'twenty second': 22, 'twenty third': 23, 'twenty fourth': 24, 'twenty fifth': 25,
  thirtieth: 30, fortieth: 40, fiftieth: 50, last: -1,
};

export function parseNumberOrOrdinal(raw: string): number | null {
  const s = raw.toLowerCase().trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const ordMatch = s.match(/^(\d+)(?:st|nd|rd|th)$/);
  if (ordMatch) return parseInt(ordMatch[1], 10);
  if (ORDINAL_WORDS[s] !== undefined) return ORDINAL_WORDS[s];
  if (NUMBER_WORDS[s] !== undefined) return NUMBER_WORDS[s];
  return null;
}

/** Canonical filter aliases */
export const FILTER_ALIASES: Record<string, string> = {
  pdf: 'pdf', 'p d f': 'pdf',
  'doc x': 'docx', docx: 'docx', docs: 'docx', word: 'docx', 'word documents': 'docx', documents: 'docx',
  text: 'txt', 'text files': 'txt', notes: 'txt',
  images: 'image', pictures: 'image', photos: 'image', image: 'image',
  code: 'code', 'code files': 'code', source: 'code',
  slides: 'slides', powerpoint: 'slides', presentations: 'slides', presentation: 'slides',
};

/** Spoken category names for "open <category>" (mirrors the sidebar: PDF, Word, Slides, Text, Images, Code). */
export const OPEN_FILTERS: Record<string, string> = {
  pdf: 'pdf', pdfs: 'pdf', 'p d f': 'pdf', 'p d f s': 'pdf',
  word: 'docx', 'word document': 'docx', 'word documents': 'docx', docx: 'docx', 'doc x': 'docx', docs: 'docx',
  slides: 'slides', slide: 'slides', powerpoint: 'slides', presentations: 'slides', presentation: 'slides',
  text: 'txt', txt: 'txt', 'text files': 'txt',
  images: 'image', image: 'image', pictures: 'image', photos: 'image',
  code: 'code', 'code files': 'code',
};

const ITEM_NOUNS = ['file', 'item', 'folder', 'document', 'page'];

// Clean and normalize text
export const norm = (s: string) =>
  s.toLowerCase()
   .replace(/[^a-z0-9\s]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

// Strip conversational lead-ins ("please", "can you", "could you", "i want to")
function stripFillers(s: string): string {
  return s
    .replace(/^(?:please|can you|could you|would you|i want to|nexus|hey nexus|system|kindly)\s+/i, '')
    .replace(/\s+(?:please|now|for me)$/i, '')
    .trim();
}

/** "Q3_Marketing-Plan.v2.docx" -> ["q3","marketing","plan"] */
export function nameTokens(name: string): string[] {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  return base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 0 && !/^v\d+$/.test(t));
}

export type ParseResult =
  | { ok: true; command: Command }
  | { ok: false; reason: 'unknown' | 'ambiguous' | 'no-such-file' };

export function parseCommand(rawText: string, files: NamedFile[]): ParseResult {
  const clean = stripFillers(norm(rawText));
  if (!clean || clean.includes('unk')) return { ok: false, reason: 'unknown' };

  // =========================================================================
  // 1. PDF PAGE NAVIGATION (Exact match and rich semantic variations)
  // =========================================================================

  // First page commands:
  // "open the first page", "go to the starting page", "start from the beginning", "take me to the initial page", "go to start"
  if (/^(?:open|go to|show|navigate to|take me to|jump to)?\s*(?:the )?(?:first page|starting page|initial page|start|beginning)$/i.test(clean) ||
      /^start from (?:the )?beginning$/i.test(clean) ||
      /^beginning of (?:the )?document$/i.test(clean)) {
    return { ok: true, command: { kind: 'pdf-page', page: 'first' } };
  }

  // Last page commands:
  // "open the last page", "go to the final page", "jump to the end", "take me to the ending page", "end of document"
  if (/^(?:open|go to|show|navigate to|take me to|jump to)?\s*(?:the )?(?:last page|final page|ending page|end)$/i.test(clean) ||
      /^jump to (?:the )?end$/i.test(clean) ||
      /^(?:the )?end of (?:the )?document$/i.test(clean)) {
    return { ok: true, command: { kind: 'pdf-page', page: 'last' } };
  }

  // Middle page commands:
  // "jump to the middle of the document", "go to the middle", "middle page", "go halfway"
  if (/^(?:jump to|go to|take me to|navigate to)?\s*(?:the )?(?:middle(?: of the document)?|halfway|center)$/i.test(clean) ||
      /^(?:middle page)$/i.test(clean)) {
    return { ok: true, command: { kind: 'pdf-page', page: 'middle' } };
  }

  // Relative page navigation:
  // "next page", "forward page", "move forward two pages", "advance 3 pages"
  let relMatch = clean.match(/^(?:move |go )?(?:forward|ahead|advance) ([a-z0-9]+) pages?$/i);
  if (relMatch) {
    const delta = parseNumberOrOrdinal(relMatch[1]);
    if (delta && delta > 0) return { ok: true, command: { kind: 'pdf-page', page: 'next', delta } };
  }
  if (/^(?:next page|next|forward page|turn page)$/i.test(clean)) {
    return { ok: true, command: { kind: 'pdf-page', page: 'next', delta: 1 } };
  }

  // "previous page", "prev page", "go back three pages", "move back 2 pages"
  relMatch = clean.match(/^(?:move |go )?back ([a-z0-9]+) pages?$/i);
  if (relMatch) {
    const delta = parseNumberOrOrdinal(relMatch[1]);
    if (delta && delta > 0) return { ok: true, command: { kind: 'pdf-page', page: 'prev', delta } };
  }
  if (/^(?:previous page|prev page|go to previous page)$/i.test(clean)) {
    return { ok: true, command: { kind: 'pdf-page', page: 'prev', delta: 1 } };
  }

  // Specific page commands:
  // "open the 8th page", "go to page eight", "show page number 8", "navigate to the eighth page", "take me to page 8", "page 8"
  const specificPagePatterns = [
    /^(?:open|go to|show|navigate to|take me to|jump to)\s*(?:the )?page (?:number )?([a-z0-9]+)$/i,
    /^(?:open|go to|show|navigate to|take me to|jump to)\s*(?:the )?([a-z0-9]+) page$/i,
    /^(?:show )?page (?:number )?([a-z0-9]+)$/i,
  ];
  for (const pat of specificPagePatterns) {
    const m = clean.match(pat);
    if (m) {
      const pageNum = parseNumberOrOrdinal(m[1]);
      if (pageNum !== null && pageNum > 0) {
        return { ok: true, command: { kind: 'pdf-page', page: pageNum } };
      }
    }
  }

  // =========================================================================
  // 2. CLOSE, SLEEP, PAUSE
  // =========================================================================
  if (/^(?:close|close it|close this|close file|close document|exit|exit preview|dismiss|dismiss preview|shut file)$/i.test(clean)) {
    return { ok: true, command: { kind: 'close' } };
  }
  if (/^(?:stop listening|go to sleep|sleep|pause voice)$/i.test(clean)) {
    return { ok: true, command: { kind: 'sleep' } };
  }
  if (/^(?:pause gestures|stop gestures|freeze gestures)$/i.test(clean)) {
    return { ok: true, command: { kind: 'pause-gestures' } };
  }
  if (/^(?:resume gestures|enable gestures|unfreeze gestures)$/i.test(clean)) {
    return { ok: true, command: { kind: 'resume-gestures' } };
  }

  // =========================================================================
  // 3. NAVIGATION (Back, Forward, Folders)
  // =========================================================================
  if (/^(?:go back|back|previous folder|up one level|return)$/i.test(clean)) {
    return { ok: true, command: { kind: 'back' } };
  }
  if (/^(?:go forward|forward|next folder)$/i.test(clean)) {
    return { ok: true, command: { kind: 'forward' } };
  }
  if (/^(?:show all folders|show folders|list folders|list all folders|folders)$/i.test(clean)) {
    return { ok: true, command: { kind: 'show-folders' } };
  }
  if (/^(?:show all files|show all|show everything|clear filter|all files|reset filter)$/i.test(clean)) {
    return { ok: true, command: { kind: 'show-all' } };
  }

  // =========================================================================
  // 4. SCROLL & ZOOM
  // =========================================================================
  if (/^(?:scroll up|page up|move up)$/i.test(clean)) {
    return { ok: true, command: { kind: 'scroll', dir: 'up' } };
  }
  if (/^(?:scroll down|page down|move down)$/i.test(clean)) {
    return { ok: true, command: { kind: 'scroll', dir: 'down' } };
  }
  if (/^(?:zoom in|magnify|enlarge)$/i.test(clean)) {
    return { ok: true, command: { kind: 'zoom', dir: 'in' } };
  }
  if (/^(?:zoom out|shrink|reduce zoom)$/i.test(clean)) {
    return { ok: true, command: { kind: 'zoom', dir: 'out' } };
  }
  if (/^(?:reset zoom|zoom reset|normal zoom|default zoom|fit to screen)$/i.test(clean)) {
    return { ok: true, command: { kind: 'zoom', dir: 'reset' } };
  }

  // =========================================================================
  // 5. SEARCH
  // =========================================================================
  const searchMatch = clean.match(/^(?:search for|search|find|look for|locate)\s*(.*)$/i);
  if (searchMatch) {
    const q = searchMatch[1].trim();
    if (!q || q === 'files' || q === 'documents') return { ok: true, command: { kind: 'begin-search' } };
    return { ok: true, command: { kind: 'search', query: q } };
  }

  // =========================================================================
  // 6. FILE OPERATIONS: CREATE FOLDER, RENAME, DELETE, COPY, MOVE
  // =========================================================================
  const createFolderMatch = clean.match(/^(?:create|make|add|new)\s+(?:folder|directory)\s*(.*)$/i);
  if (createFolderMatch) {
    const name = createFolderMatch[1].trim();
    return { ok: true, command: { kind: 'create-folder', name: name || undefined } };
  }

  const renameMatch = clean.match(/^(?:rename|change name)(?:\s+(?:file|document|this))?\s+to\s+(.+)$/i);
  if (renameMatch) {
    return { ok: true, command: { kind: 'rename', newName: renameMatch[1].trim(), target: { by: 'selection' } } };
  }

  if (/^(?:delete|remove|trash|discard)\s*(?:the )?(?:file|this|document|selected|item)?$/i.test(clean)) {
    return { ok: true, command: { kind: 'delete', target: { by: 'selection' } } };
  }
  const deleteNamed = clean.match(/^(?:delete|remove|trash)\s+(.+)$/i);
  if (deleteNamed) {
    const target = resolveTarget(deleteNamed[1], files);
    if (target.ok) return { ok: true, command: { kind: 'delete', target: target.target } };
  }

  if (/^(?:copy|duplicate)\s*(?:the )?(?:file|this|document|selected|item)?$/i.test(clean)) {
    return { ok: true, command: { kind: 'copy', target: { by: 'selection' } } };
  }

  const moveMatch = clean.match(/^(?:move|relocate|transfer)(?:\s+(?:the )?(?:file|this|document|selected))?\s+to\s+(.+)$/i);
  if (moveMatch) {
    return { ok: true, command: { kind: 'move', destination: moveMatch[1].trim(), target: { by: 'selection' } } };
  }

  // =========================================================================
  // 7. FILTERING
  // =========================================================================
  for (const alias of Object.keys(FILTER_ALIASES)) {
    if (clean === `filter ${alias}` || clean === `show only ${alias}` || clean === `filter ${alias} files`) {
      return { ok: true, command: { kind: 'filter', ext: FILTER_ALIASES[alias] } };
    }
  }

  // "open pdf", "open all", "open word files", "open images", "open folders" ... = same as the sidebar buttons
  const catMatch = clean.match(/^(?:open|show(?: me)?|display|go to|view)\s+(?:the |all the |all |only )?(.+?)(?: files| documents| folder)?$/i);
  if (catMatch) {
    const key = catMatch[1].trim();
    if (key === 'all' || key === 'everything') return { ok: true, command: { kind: 'show-all' } };
    if (key === 'folders' || key === 'folder') return { ok: true, command: { kind: 'show-folders' } };
    if (OPEN_FILTERS[key]) return { ok: true, command: { kind: 'filter', ext: OPEN_FILTERS[key] } };
  }

  // =========================================================================
  // 8. SELECTION
  // =========================================================================
  const selectMatch = clean.match(/^(?:select|pick|choose|highlight)\s+(.+)$/i);
  if (selectMatch) {
    const arg = selectMatch[1].trim();
    if (/^(?:file|this|item|document)$/i.test(arg)) {
      return { ok: true, command: { kind: 'select', target: { by: 'selection' } } };
    }
    const target = resolveTarget(arg, files);
    if (target.ok) return { ok: true, command: { kind: 'select', target: target.target } };
    if (!target.ok) return { ok: false, reason: target.reason };
  }

  // =========================================================================
  // 9. OPEN / LAUNCH / DISPLAY / SHOW FILE OR FOLDER
  // =========================================================================
  // Natural variations for open selected / open file:
  // "open the file", "show me the document", "display this file", "launch the document", "open it", "view file"
  if (/^(?:open|show(?: me)?|display|launch|view|bring up)\s*(?:the |this )?(?:file|document|item|it|selected|one)?$/i.test(clean) ||
      /^(?:open|show(?: me)?|display|launch|view|bring up)\s*(?:this|it|selected)$/i.test(clean)) {
    return { ok: true, command: { kind: 'open', target: { by: 'selection' } } };
  }

  // "open <target>" / "show <target>" / "launch <target>" / "display <target>"
  const openMatch = clean.match(/^(?:open|show(?: me)?|display|launch|view|bring up|load)\s+(.+)$/i);
  if (openMatch) {
    const target = resolveTarget(openMatch[1], files);
    if (target.ok) return { ok: true, command: { kind: 'open', target: target.target } };
    return { ok: false, reason: target.reason };
  }

  return { ok: false, reason: 'unknown' };
}

function resolveTarget(phrase: string, files: NamedFile[]): { ok: true; target: FileTarget } | { ok: false; reason: 'ambiguous' | 'no-such-file' } {
  const p = phrase.toLowerCase().trim();

  // Ordinal target: "first file", "the 3rd item", "third document", "last item"
  const ordNounMatch = p.match(/^(?:the )?([a-z0-9]+)\s+(?:file|item|folder|document)$/i);
  if (ordNounMatch) {
    const idx = parseNumberOrOrdinal(ordNounMatch[1]);
    if (idx !== null) return { ok: true, target: { by: 'index', index: idx } };
  }

  // Number target: "file number three", "number 3", "item 2"
  const numMatch = p.match(/^(?:file |item )?number ([a-z0-9]+)$/i) || p.match(/^number ([a-z0-9]+)$/i);
  if (numMatch) {
    const n = parseNumberOrOrdinal(numMatch[1]);
    if (n !== null && n >= 1) return { ok: true, target: { by: 'index', index: n } };
  }

  // Ordinal directly: "third", "first", "last"
  if (ORDINAL_WORDS[p] !== undefined) {
    return { ok: true, target: { by: 'index', index: ORDINAL_WORDS[p] } };
  }

  // Token / Name match against visible files
  const spoken = p.split(' ');
  const full = files.filter(f => norm(nameTokens(f.name).join(' ')) === p);
  if (full.length === 1) return { ok: true, target: { by: 'file', fileId: full[0].id } };

  const cands = files.filter(f => {
    const tk = nameTokens(f.name);
    return spoken.every(w => tk.includes(w));
  });
  if (cands.length === 1) return { ok: true, target: { by: 'file', fileId: cands[0].id } };
  if (cands.length > 1) return { ok: false, reason: 'ambiguous' };

  return { ok: false, reason: 'no-such-file' };
}

/** Everything the command recogniser is allowed to say. "[unk]" absorbs everything else. */
export function buildCommandGrammar(files: NamedFile[]): string[] {
  const phrases = new Set<string>();

  const verbs = ['open', 'show', 'display', 'launch', 'view', 'close', 'select', 'pick', 'choose', 'create', 'make', 'rename', 'delete', 'copy', 'move'];
  const nouns = ['file', 'the file', 'this file', 'document', 'the document', 'item', 'folder', 'directory', 'it', 'this', 'selected'];

  for (const v of verbs) {
    for (const n of nouns) {
      phrases.add(`${v} ${n}`);
    }
  }

  // PDF Page navigation
  const pagePrefixes = ['open', 'go to', 'show', 'navigate to', 'take me to', 'jump to'];
  const numbers = Object.keys(NUMBER_WORDS);
  const ordinals = Object.keys(ORDINAL_WORDS).filter(w => /^[a-z]+$/.test(w));

  for (const pfx of pagePrefixes) {
    phrases.add(`${pfx} first page`);
    phrases.add(`${pfx} the first page`);
    phrases.add(`${pfx} last page`);
    phrases.add(`${pfx} the last page`);
    phrases.add(`${pfx} starting page`);
    phrases.add(`${pfx} final page`);
    phrases.add(`${pfx} ending page`);
    phrases.add(`${pfx} the middle`);
    phrases.add(`${pfx} the middle of the document`);
    for (const num of numbers) {
      phrases.add(`${pfx} page ${num}`);
      phrases.add(`${pfx} page number ${num}`);
      phrases.add(`page ${num}`);
    }
    for (const ord of ordinals) {
      phrases.add(`${pfx} ${ord} page`);
      phrases.add(`${pfx} the ${ord} page`);
    }
  }

  phrases.add('start from the beginning');
  phrases.add('start from beginning');
  phrases.add('beginning of document');
  phrases.add('jump to the end');
  phrases.add('jump to end');
  phrases.add('end of document');
  phrases.add('middle of document');
  phrases.add('middle page');
  phrases.add('next page');
  phrases.add('previous page');
  phrases.add('prev page');
  for (const num of ['two', 'three', 'four', 'five']) {
    phrases.add(`move forward ${num} pages`);
    phrases.add(`go back ${num} pages`);
  }

  // Navigation, Scroll, Zoom
  phrases.add('go back');
  phrases.add('back');
  phrases.add('go forward');
  phrases.add('forward');
  phrases.add('scroll up');
  phrases.add('scroll down');
  phrases.add('page up');
  phrases.add('page down');
  phrases.add('zoom in');
  phrases.add('zoom out');
  phrases.add('reset zoom');
  phrases.add('zoom reset');
  phrases.add('show all folders');
  phrases.add('show folders');
  phrases.add('show all files');
  phrases.add('show everything');
  phrases.add('clear filter');
  phrases.add('stop listening');
  phrases.add('go to sleep');
  phrases.add('search');
  phrases.add('search files');
  phrases.add('create folder');
  phrases.add('make folder');
  phrases.add('delete file');
  phrases.add('copy file');
  phrases.add('rename file');

  for (const a of Object.keys(OPEN_FILTERS)) {
    phrases.add(`open ${a}`);
    phrases.add(`open all ${a}`);
    phrases.add(`show ${a}`);
  }
  for (const w of ['open all', 'open all files', 'open everything', 'open folders', 'open all folders', 'show all', 'show folders']) phrases.add(w);

  for (const a of Object.keys(FILTER_ALIASES)) {
    phrases.add(`filter ${a}`);
    phrases.add(`show only ${a}`);
  }

  for (const ord of ordinals) {
    for (const n of ['file', 'item', 'folder', 'document']) {
      phrases.add(`open ${ord} ${n}`);
      phrases.add(`open the ${ord} ${n}`);
      phrases.add(`select ${ord} ${n}`);
      phrases.add(`select the ${ord} ${n}`);
    }
  }

  for (const f of files) {
    const toks = nameTokens(f.name);
    if (!toks.length) continue;
    phrases.add(`open ${toks.join(' ')}`);
    phrases.add(`select ${toks.join(' ')}`);
    for (const t of toks) {
      if (t.length >= 4 && !/^\d+$/.test(t)) {
        phrases.add(`open ${t}`);
        phrases.add(`select ${t}`);
      }
    }
  }

  return [...phrases, '[unk]'];
}

export const WAKE_GRAMMAR = [WAKE_PHRASE, '[unk]'];
export const isWakePhrase = (text: string) => norm(stripFillers(text)) === WAKE_PHRASE;