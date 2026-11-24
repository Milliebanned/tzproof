// Expected dates are computed from the cell's warped instant, in the cell's time zone.
// Shown dates are whatever text Kane read off the page; we parse them leniently, then compare calendar days.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|nesday|rsday|urday)?\b,?/gi;

/** Calendar date {y, m, d} of an instant as seen in a time zone. */
export function localDate(atMs, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(atMs));
  const get = type => Number(parts.find(p => p.type === type).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

export function formatYmd({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add days or months to a calendar date. Months clamp to the end of the month (Jan 31 + 1mo = Feb 28/29). */
export function addToDate({ y, m, d }, amount, unit) {
  if (unit === 'd' || unit === 'w') {
    const t = new Date(Date.UTC(y, m - 1, d + amount * (unit === 'w' ? 7 : 1)));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  if (unit === 'mo' || unit === 'y') {
    const total = (y * 12 + (m - 1)) + amount * (unit === 'y' ? 12 : 1);
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
  }
  throw new Error(`Unknown unit "${unit}"`);
}

/**
 * Resolve an expected-date expression for a cell.
 * Supported: "today", "today+14d", "today-1d", "today+2w", "today+1mo", "today+1y", or a literal "YYYY-MM-DD".
 */
export function resolveDateExpr(expr, atMs, tz) {
  const text = String(expr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split('-').map(Number);
    return { y, m, d };
  }
  const match = text.match(/^today(?:\s*([+-])\s*(\d+)\s*(d|w|mo|y))?$/i);
  if (!match) throw new Error(`Cannot understand date expression "${expr}"`);
  const base = localDate(atMs, tz);
  if (!match[1]) return base;
  const amount = Number(match[2]) * (match[1] === '-' ? -1 : 1);
  return addToDate(base, amount, match[3].toLowerCase());
}

/**
 * Parse a date as displayed on a page. `order` breaks ties for numeric dates like 04/09/2026 ("mdy" or "dmy").
 * Returns {y, m, d} or null when the text holds no recognisable date.
 */
export function parseShownDate(raw, order = 'mdy') {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).replace(WEEKDAYS, ' ').replace(/\s+/g, ' ').trim();

  let match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return valid(+match[1], +match[2], +match[3]);

  const monthWord = new RegExp(`\\b(${MONTHS.map(n => n.slice(0, 3)).join('|')})[a-z]*\\.?`, 'i');
  // "April 10, 2026" / "Apr 10 2026"
  match = text.match(new RegExp(`${monthWord.source}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'));
  if (match) return valid(+match[3], monthIndex(match[1]), +match[2]);
  // "10 April 2026" / "10 Apr, 2026"
  match = text.match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthWord.source},?\\s+(\\d{4})`, 'i'));
  if (match) return valid(+match[3], monthIndex(match[2]), +match[1]);

  match = text.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (match) {
    const a = +match[1], b = +match[2], y = +match[3];
    if (a > 12) return valid(y, b, a);
    if (b > 12) return valid(y, a, b);
    return order === 'dmy' ? valid(y, b, a) : valid(y, a, b);
  }
  return null;
}

function monthIndex(word) {
  return MONTHS.findIndex(name => name.startsWith(word.toLowerCase().slice(0, 3))) + 1;
}

function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function sameDay(a, b) {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}
