const PREFIX_RE = /\b(?:expires?|valid\s+through|valid\s+until)\b(?:\s+(?:on|by))?\s*:?\s+/gi;
const TIME_RE = /\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b/i;

function parseDate(s: string, now: Date): number | null {
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3]);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const hasYear = /\b\d{4}\b/.test(s) || /[\/\-]\d{2,4}\s*$/.test(s);
  const ts = Date.parse(hasYear ? s : `${s}, ${now.getFullYear()}`);
  if (isNaN(ts)) return null;
  if (hasYear) return ts;
  const ageDays = (now.getTime() - ts) / 86_400_000;
  if (ageDays <= 60) return ts;
  const d = new Date(ts);
  d.setFullYear(d.getFullYear() + 1);
  return d.getTime();
}

interface ParseResult { ts: number; hasTime: boolean }

function tryParseChunk(chunk: string, now: Date): ParseResult | null {
  const cleaned = chunk.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1");
  const tokens = cleaned.split(/\s+/).slice(0, 5);
  let best: ParseResult | null = null;
  for (let n = 1; n <= tokens.length; n++) {
    const candidate = tokens
      .slice(0, n)
      .map((t) => t.replace(/[,;.]+$/, ""))
      .join(" ")
      .replace(/(\d)(am|pm)\b/gi, "$1 $2");
    const ts = parseDate(candidate, now);
    if (ts !== null) best = { ts, hasTime: TIME_RE.test(candidate) };
  }
  return best;
}

function lastValidDayStart(result: ParseResult): number {
  if (!result.hasTime) return result.ts;
  const d = new Date(result.ts - 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function extractExpiryDate(text: string, now: Date = new Date()): number | null {
  if (!text) return null;
  const candidates: number[] = [];
  for (const m of text.matchAll(PREFIX_RE)) {
    const start = m.index! + m[0].length;
    const result = tryParseChunk(text.slice(start, start + 50), now);
    if (result !== null) candidates.push(lastValidDayStart(result));
  }
  if (candidates.length === 0) return null;
  const cutoff = now.getTime() - 30 * 86_400_000;
  const relevant = candidates.filter((ts) => ts >= cutoff);
  return relevant.length > 0 ? Math.min(...relevant) : Math.max(...candidates);
}
