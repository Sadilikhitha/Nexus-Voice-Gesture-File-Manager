/**
 * Extract a time hint ("last week", "yesterday"...) from a natural-language query.
 * Returned as a SOFT signal: files inside the range get a score boost rather than
 * everything outside being hidden — "last week" is fuzzy in human speech, and a
 * hard filter would silently drop a file edited two days ago.
 */
export interface TimeHint { from: number; to: number; matched: string }
const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function extractTimeHint(q: string, now = Date.now()): { text: string; hint: TimeHint | null } {
  const today = startOfDay(new Date(now));
  const dow = (new Date(now).getDay() + 6) % 7; // Monday = 0
  const rules: [RegExp, () => [number, number]][] = [
    [/\byesterday\b/i, () => [today - DAY, today]],
    [/\btoday\b/i, () => [today, today + DAY]],
    [/\b(this|past) week\b/i, () => [today - dow * DAY, today + DAY]],
    [/\blast week\b/i, () => [today - (dow + 7) * DAY, today - dow * DAY]],
    [/\b(this|past) month\b/i, () => [today - 30 * DAY, today + DAY]],
    [/\blast month\b/i, () => { const d = new Date(now); return [new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), new Date(d.getFullYear(), d.getMonth(), 1).getTime()]; }],
    [/\b(?:last|past) (\d{1,3}) days\b/i, () => [0, 0]], // handled below
  ];
  for (const [re, range] of rules) {
    const m = q.match(re);
    if (!m) continue;
    let [from, to] = range();
    if (m[1] && /^\d+$/.test(m[1])) { from = today - parseInt(m[1], 10) * DAY; to = today + DAY; }
    return { text: q.replace(re, ' ').replace(/\s+/g, ' ').trim(), hint: { from, to, matched: m[0] } };
  }
  return { text: q, hint: null };
}

/** Strip conversational filler so the embedding sees the content words. */
export function cleanQuery(q: string): string {
  return q
    .replace(/\b(find|show|search|look for|get|give|open|bring up|pull up)( me)?\b/gi, ' ')
    .replace(/\b(the|a|an|my|all|any|some|that|those|these|files?|documents?|docs?)\b/gi, ' ')
    .replace(/\b(i|we)( have| had)?\b/gi, ' ')
    .replace(/\b(edited|modified|changed|updated|created|worked on|opened|saved|about|regarding|related to|on)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
