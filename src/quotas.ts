import db from "./db";

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
    throw new Error(`429: rate limit exceeded (${rpmLimit}/min)`);
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
    throw new Error(`429: daily token cap reached (${dailyCap})`);
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
  return { day, tokensToday: daily, tokensMonth: monthly };
}
