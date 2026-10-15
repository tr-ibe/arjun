// Recognises the Max plan's usage-limit message in Claude Code's output and works out when it resets.
// Claude Code has printed this in a few shapes over time, e.g.
//   "Claude AI usage limit reached|1760540400"
//   "5-hour limit reached ∙ resets 3pm"
//   "You've hit your limit · resets Oct 20, 3pm (Asia/Kolkata)"

const LIMIT_RE = /usage limit|limit reached|hit your (usage )?limit|limit will reset/i;
const EPOCH_RE = /limit reached\|(\d{10})/i;
const RESETS_RE =
  /resets?\s+(?:at\s+)?(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const FALLBACK_MS = 30 * 60 * 1000;

export function detectUsageLimit(output: string, nowDate = new Date()): { resetsAt: Date } | null {
  if (!LIMIT_RE.test(output)) return null;

  const epoch = output.match(EPOCH_RE);
  if (epoch) return { resetsAt: new Date(Number(epoch[1]) * 1000) };

  const m = output.match(RESETS_RE);
  if (m) {
    const parsed = resetTime(m, nowDate);
    if (parsed) return { resetsAt: parsed };
  }

  // Couldn't read the reset time: try again in 30 minutes.
  return { resetsAt: new Date(nowDate.getTime() + FALLBACK_MS) };
}

function resetTime(m: RegExpMatchArray, nowDate: Date): Date | null {
  const [, monthName, dayStr, hourStr, minStr, ampm, tzName] = m;
  let hour = Number(hourStr);
  const minute = Number(minStr ?? 0);
  if (ampm) {
    hour = hour % 12;
    if (ampm.toLowerCase() === "pm") hour += 12;
  }
  if (hour > 23 || minute > 59) return null;

  const tz = tzName && isTimeZone(tzName) ? tzName : "UTC";
  const today = partsIn(tz, nowDate);
  let year = today.year;
  let month = today.month;
  let day = today.day;
  if (monthName) {
    const idx = MONTHS.indexOf(monthName.toLowerCase());
    if (idx < 0) return null;
    month = idx + 1;
    day = Number(dayStr);
    if (month < today.month) year += 1;
  }

  let at = wallTimeToDate(year, month, day, hour, minute, tz);
  if (!monthName && at.getTime() <= nowDate.getTime()) {
    at = new Date(at.getTime() + 24 * 60 * 60 * 1000);
  }
  // A minute of slack so the next run doesn't start a moment too early.
  return new Date(at.getTime() + 60_000);
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function partsIn(tz: string, date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function offsetMinutes(tz: string, date: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

function wallTimeToDate(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(asUtc - offsetMinutes(tz, new Date(asUtc)) * 60_000);
}
