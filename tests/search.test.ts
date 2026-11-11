import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTimeHint, cleanQuery } from '../src/search/timeRange';

const NOW = new Date(2026, 10, 8, 15, 0).getTime(); // Sun 8 Nov 2026

test('time hints', () => {
  const r = extractTimeHint('Find the resume I edited last week', NOW);
  assert.equal(r.hint?.matched, 'last week');
  assert.equal(cleanQuery(r.text), 'resume');
  const y = extractTimeHint('notes from yesterday', NOW);
  assert.ok(y.hint && y.hint.to - y.hint.from === 86_400_000);
  assert.equal(extractTimeHint('marketing project', NOW).hint, null);
  assert.equal(extractTimeHint('files from last 3 days', NOW).hint?.matched, 'last 3 days');
});
test('query cleaning keeps content words', () => {
  assert.equal(cleanQuery('Show me documents about the marketing project'), 'marketing project');
});
