/**
 * Typed event bus built on window CustomEvents.
 *
 * Why DOM events: gesture + voice modules stay decoupled from React. Any
 * component (or plain DOM code) can listen with addEventListener('nexus:tap').
 * Detail payloads are plain JSON-able objects (safe to cross worker boundaries).
 */

export type FileTarget =
  | { by: 'file'; fileId: string }
  | { by: 'index'; index: number } // 1-based, -1 = last
  | { by: 'selection' }
  | { by: 'name'; name: string };

export type Command =
  | { kind: 'open'; target: FileTarget }
  | { kind: 'close' }
  | { kind: 'select'; target: FileTarget }
  | { kind: 'create-folder'; name?: string }
  | { kind: 'rename'; newName?: string; target?: FileTarget }
  | { kind: 'delete'; target?: FileTarget }
  | { kind: 'copy'; target?: FileTarget }
  | { kind: 'move'; destination?: string; target?: FileTarget }
  | { kind: 'pdf-page'; page: number | 'next' | 'prev' | 'first' | 'last' | 'middle'; delta?: number }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'show-folders' }
  | { kind: 'show-all' }
  | { kind: 'filter'; ext: string }
  | { kind: 'scroll'; dir: 'up' | 'down' }
  | { kind: 'zoom'; dir: 'in' | 'out' | 'reset' }
  | { kind: 'sleep' }          // end the voice session now
  | { kind: 'begin-search' } // "search" -> next utterance is free-form dictation
  | { kind: 'search'; query: string }
  | { kind: 'pause-gestures' }
  | { kind: 'resume-gestures' };

export interface NexusEvents {
  /** Hand cursor in VIEWPORT PIXELS. */
  'nexus:cursor': { x: number; y: number; visible: boolean; pinching: boolean };
  /** dy = pixels to scroll for this frame (negative = up). */
  'nexus:scroll': { dy: number };
  /** delta = multiplicative factor for this frame (1.02 = +2 %). */
  'nexus:zoom': { delta: number };
  'nexus:tap': { x: number; y: number };
  'nexus:swipe': { dir: 'left' | 'right' | 'up' | 'down' };
  'nexus:gesture-state': { state: 'idle' | 'arming' | 'engaged' | 'paused' };
  /** Wake-word window opened/closed. */
  'nexus:wake': { active: boolean; mode: 'command' | 'dictation' };
  'nexus:partial': { text: string };
  'nexus:command': { command: Command; heard: string; confidence: number };
  /** Heard something while awake but could not map it to a safe command. */
  'nexus:rejected': { heard: string; reason: string };
  'nexus:level': { rms: number; floor: number; speaking: boolean };
  'nexus:health': { source: 'gesture' | 'voice'; ok: boolean; reason?: string };
  'nexus:nav': { dir: 'back' | 'forward' };
  'nexus:gesture-debug': { text: string };
  'nexus:pdf-jump': { page: number };
}

export function emit<K extends keyof NexusEvents>(type: K, detail: NexusEvents[K]): void {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/** Subscribe; returns an unsubscribe function (handy in useEffect). */
export function on<K extends keyof NexusEvents>(
  type: K,
  fn: (detail: NexusEvents[K]) => void,
): () => void {
  const h = (e: Event) => fn((e as CustomEvent<NexusEvents[K]>).detail);
  window.addEventListener(type, h);
  return () => window.removeEventListener(type, h);
}