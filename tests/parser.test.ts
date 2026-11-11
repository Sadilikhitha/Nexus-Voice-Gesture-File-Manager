import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, buildCommandGrammar, isWakePhrase, nameTokens } from '../src/voice/CommandParser';

const files = [
  { id: 'a', name: 'Resume_2026.pdf' },
  { id: 'b', name: 'Marketing_Plan_Q3.docx' },
  { id: 'c', name: 'Marketing_Budget.csv' },
  { id: 'd', name: 'notes.txt' },
];
const p = (s: string) => parseCommand(s, files);

test('spec commands', () => {
  assert.deepEqual(p('open resume'), { ok: true, command: { kind: 'open', target: { by: 'file', fileId: 'a' } } });
  assert.deepEqual(p('close it'), { ok: true, command: { kind: 'close' } });
  assert.deepEqual(p('open third file'), { ok: true, command: { kind: 'open', target: { by: 'index', index: 3 } } });
  assert.deepEqual(p('open 3rd file'), { ok: true, command: { kind: 'open', target: { by: 'index', index: 3 } } });
  assert.deepEqual(p('go back'), { ok: true, command: { kind: 'back' } });
  assert.deepEqual(p('show all folders'), { ok: true, command: { kind: 'show-folders' } });
  assert.deepEqual(p('filter doc x'), { ok: true, command: { kind: 'filter', ext: 'docx' } });
  assert.deepEqual(p('Filter PDF!'), { ok: true, command: { kind: 'filter', ext: 'pdf' } });
});

test('FP: conversation containing command words is rejected (anchored)', () => {
  for (const s of [
    'i think we should open the window', 'can you go back to the last slide',
    'please close it later', 'we need to filter the coffee', 'back in a minute', 'open', 'open the', '',
    'open the third file please', 'show all folders now', 'zoom in on that',
  ]) assert.equal(p(s).ok, false, s);
});

test('ambiguity and unknown files do nothing', () => {
  assert.deepEqual(p('open marketing'), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(p('open marketing plan'), { ok: true, command: { kind: 'open', target: { by: 'file', fileId: 'b' } } });
  assert.deepEqual(p('open vacation'), { ok: false, reason: 'no-such-file' });
  assert.equal(p('open [unk]').ok, false);
});

test('wake gate is exact', () => {
  assert.ok(isWakePhrase('Hey Nexus'));
  assert.ok(!isWakePhrase('hey nexus open resume'));
  assert.ok(!isWakePhrase('oh hey nexus is great'));
});

test('grammar is closed over parser: every phrase either parses or is a file-name phrase', () => {
  const g = buildCommandGrammar(files).filter(x => x !== '[unk]');
  const bad = g.filter(ph => !p(ph).ok && !/^open /.test(ph));
  assert.deepEqual(bad, []);
  assert.ok(g.includes('open resume') && g.includes('open marketing plan q3'));
});

test('name tokenisation', () => {
  assert.deepEqual(nameTokens('Q3_Marketing-Plan.v2.docx'), ['q3', 'marketing', 'plan']);
  assert.deepEqual(nameTokens('myResumeFinal.pdf'), ['my', 'resume', 'final']);
});

test('zoom reset + slides filter', () => {
  assert.deepEqual(parseCommand('reset zoom', []), { ok: true, command: { kind: 'zoom', dir: 'reset' } });
  assert.deepEqual(parseCommand('filter powerpoint', []), { ok: true, command: { kind: 'filter', ext: 'slides' } });
});

test('"open <category>" behaves like the sidebar buttons', () => {
  assert.deepEqual(parseCommand('open pdf', []), { ok: true, command: { kind: 'filter', ext: 'pdf' } });
  assert.deepEqual(parseCommand('open all pdf files', []), { ok: true, command: { kind: 'filter', ext: 'pdf' } });
  assert.deepEqual(parseCommand('open word', []), { ok: true, command: { kind: 'filter', ext: 'docx' } });
  assert.deepEqual(parseCommand('open images', []), { ok: true, command: { kind: 'filter', ext: 'image' } });
  assert.deepEqual(parseCommand('open all', []), { ok: true, command: { kind: 'show-all' } });
  assert.deepEqual(parseCommand('open folders', []), { ok: true, command: { kind: 'show-folders' } });
});
