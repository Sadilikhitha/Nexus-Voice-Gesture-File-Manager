import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanDirectory, kindOf, getHandle } from '../src/fs/FsAdapter';

const fileEntry = (name: string, text: string, mtime: number) => ({
  kind: 'file', name, getFile: async () => new File([text], name, { lastModified: mtime }),
});
const dirEntry = (name: string, children: any[]): any => ({ kind: 'directory', name, values: async function* () { yield* children; } });

test('kind detection', () => {
  assert.equal(kindOf('a.PDF'), 'pdf'); assert.equal(kindOf('x.docx'), 'docx'); assert.equal(kindOf('p.jpeg'), 'image');
  assert.equal(kindOf('m.py'), 'code'); assert.equal(kindOf('n.md'), 'txt'); assert.equal(kindOf('deck.pptx'), 'slides'); assert.equal(kindOf('weird.xyz'), 'other'); assert.equal(kindOf('Makefile'), 'other');
});

test('scan builds tree, skips hidden/junk, reads snippets, folder mtime = newest child', async () => {
  const root = dirEntry('Docs', [
    fileEntry('resume.txt', 'Software   engineer\nwith React', 1000),
    fileEntry('.secret', 'x', 1), dirEntry('node_modules', [fileEntry('a.js', '1', 1)]),
    dirEntry('Work', [fileEntry('plan.md', '# Marketing plan', 5000), fileEntry('pic.png', 'binary', 3000)]),
  ]);
  const r = await scanDirectory(root);
  const by = Object.fromEntries(r.files.map(f => [f.id, f]));
  assert.deepEqual(Object.keys(by).sort(), ['Work', 'Work/pic.png', 'Work/plan.md', 'resume.txt']);
  assert.equal(by['Work/plan.md'].parentId, 'Work'); assert.equal(by['resume.txt'].parentId, null);
  assert.equal(by['resume.txt'].snippet, 'Software engineer with React');
  assert.equal(by['Work/pic.png'].snippet, 'pic.png');           // binary: no content read
  assert.equal(by['Work'].modified, 5000);
  assert.ok(getHandle('resume.txt'));
});

test('ingestHandles: loose files + dropped folder, unique ids, append mode', async () => {
  const { ingestHandles } = await import('../src/fs/FsAdapter');
  const a = fileEntry('report.pdf', 'x', 7000);
  const folder = dirEntry('Downloads2', [fileEntry('inv.txt', 'invoice total', 9000)]);
  const r1 = await ingestHandles([a, folder]);
  const r2 = await ingestHandles([a]);                       // same file again -> different id
  assert.equal(r1.files.length, 3);
  assert.equal(r1.files.find(f => f.name === 'inv.txt')!.parentId, r1.files.find(f => f.name === 'Downloads2')!.id);
  assert.equal(r1.files.find(f => f.name === 'Downloads2')!.modified, 9000);
  assert.notEqual(r1.files[0].id, r2.files[0].id);
  assert.equal(r1.files[0].parentId, null);
});
