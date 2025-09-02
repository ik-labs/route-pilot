import db from "./db.js";
import { QuotaError } from "./util/errors.js";

const DEFAULT_TZ = "Asia/Kolkata";

function dayInTZ(tz?: string): string {
  const zone = tz || process.env.TZ || DEFAULT_TZ;
  const now = new Date();
  return now.toLocaleString("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function monthRangeInTZ(tz?: string): { start: string; end: string } {
  const zone = tz || process.env.TZ || DEFAULT_TZ;
  const now = new Date();
  const y = now.toLocaleString("en-CA", { timeZone: zone, year: "numeric" });
  const m = now.toLocaleString("en-CA", { timeZone: zone, month: "2-digit" });
  const start = `${y}-${m}-01`;
  const end = `${y}-${m}-31`;
  return { start, end };
}

export function assertWithinRpm(userRef: string, rpmLimit: number) {
  const now = Date.now();
  const windowStart = now - 60_000;
  db.prepare("DELETE FROM rpm_events WHERE ts < ?").run(windowStart);
  const row = db
    .prepare("SELECT COUNT(*) as c FROM rpm_events WHERE user_ref=? AND ts>=?")
    .get(userRef, windowStart) as { c: number };
  if ((row?.c ?? 0) >= rpmLimit)
    throw new QuotaError("rpm", `rate limit exceeded (${rpmLimit}/min)` , rpmLimit);
  db.prepare("INSERT INTO rpm_events(user_ref, ts) VALUES(?, ?)").run(
    userRef,
    now
  );
}

export function addDailyTokens(
  userRef: string,
  tokens: number,
  dailyCap: number,
  tz?: string
) {
  const day = dayInTZ(tz);
  const row = db
    .prepare(
      "SELECT tokens FROM quotas_daily WHERE user_ref=? AND day=?"
    )
    .get(userRef, day) as { tokens: number } | undefined;
  const newTokens = (row?.tokens ?? 0) + tokens;
  if (newTokens > dailyCap)
    throw new QuotaError("daily", `daily token cap reached (${dailyCap})` , dailyCap, day);
  if (row) {
    db.prepare("UPDATE quotas_daily SET tokens=? WHERE user_ref=? AND day=?").run(
      newTokens,
      userRef,
      day
    );
  } else {
    db.prepare(
      "INSERT INTO quotas_daily(user_ref, day, tokens) VALUES(?,?,?)"
    ).run(userRef, day, tokens);
  }
}

export function usageSummary(userRef: string, tz?: string) {
  const day = dayInTZ(tz);
  const daily = (db
    .prepare("SELECT tokens FROM quotas_daily WHERE user_ref=? AND day=?")
    .get(userRef, day) as { tokens: number } | undefined)?.tokens ?? 0;
  const { start, end } = monthRangeInTZ(tz);
  const monthly = (db
    .prepare(
      "SELECT COALESCE(SUM(tokens),0) as t FROM quotas_daily WHERE user_ref=? AND day BETWEEN ? AND ?"
    )
    .get(userRef, start, end) as { t: number }).t;
  return { day, tokensToday: daily, tokensMonth: monthly, resetsAt: resetsAtString(tz) };
}

export function resetDailyTokens(userRef: string, tz?: string) {
  const day = dayInTZ(tz);
  const row = db.prepare("SELECT tokens FROM quotas_daily WHERE user_ref=? AND day=?").get(userRef, day) as { tokens: number } | undefined;
  if (!row) return; // nothing to reset
  db.prepare("UPDATE quotas_daily SET tokens=0 WHERE user_ref=? AND day=?").run(userRef, day);
}

function resetsAtString(tz?: string): string {
  // Provide a readable local reset time string: next day at 00:00 in tz
  const zone = tz || process.env.TZ || DEFAULT_TZ;
  const now = new Date();
  const y = now.toLocaleString("en-CA", { timeZone: zone, year: "numeric" });
  const m = now.toLocaleString("en-CA", { timeZone: zone, month: "2-digit" });
  const d = now.toLocaleString("en-CA", { timeZone: zone, day: "2-digit" });
  // Compute next day
  const asInt = (s: string) => parseInt(s, 10);
  let yy = asInt(y), mm = asInt(m), dd = asInt(d) + 1;
  const daysInMonth = new Date(yy, mm, 0).getDate();
  if (dd > daysInMonth) { dd = 1; mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${yy}-${pad(mm)}-${pad(dd)}T00:00:00 ${zone}`;
}
