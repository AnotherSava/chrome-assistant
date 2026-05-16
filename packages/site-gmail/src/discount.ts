const PREFIX_RE = /\bmax(?:imum)?\s+discount\b/gi;
const AMOUNT_RE = /\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

export function extractMaxDiscount(text: string): number | null {
  if (!text) return null;
  const amounts: number[] = [];
  for (const m of text.matchAll(PREFIX_RE)) {
    const start = m.index! + m[0].length;
    const chunk = text.slice(start, start + 80);
    const match = chunk.match(AMOUNT_RE);
    if (match) amounts.push(parseFloat(match[1].replace(/,/g, "")));
  }
  return amounts.length > 0 ? Math.max(...amounts) : null;
}
