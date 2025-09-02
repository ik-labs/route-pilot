import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = path.join("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, "routepilot.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// schema (idempotent)
db.exec(`
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  policy TEXT NOT NULL,
  route_primary TEXT,
  route_final TEXT,
  fallback_count INTEGER DEFAULT 0,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  task_id TEXT,
  parent_id TEXT,
  reasons TEXT,               -- JSON array of reasons for fallbacks
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  signature TEXT,
  payload_json TEXT
);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  user_ref TEXT,
  policy TEXT,
  route_primary TEXT,
  route_final TEXT,
  latency_ms INTEGER,
  tokens INTEGER,
  cost_usd REAL
);
CREATE TABLE IF NOT EXISTS quotas_daily (
  user_ref TEXT NOT NULL,
  day TEXT NOT NULL,            -- 'YYYY-MM-DD' in Asia/Kolkata
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_ref, day)
);
CREATE TABLE IF NOT EXISTS rpm_events (
  user_ref TEXT NOT NULL,
  ts INTEGER NOT NULL           -- epoch ms; prune < now-60s
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_ref TEXT NOT NULL,
  agent TEXT NOT NULL,
  policy TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- system|user|assistant
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
-- Indices for performance and p95 lookups
CREATE INDEX IF NOT EXISTS traces_route_ts ON traces(route_final, ts DESC);
CREATE INDEX IF NOT EXISTS rpm_user_ts     ON rpm_events(user_ref, ts);
CREATE INDEX IF NOT EXISTS quotas_pk       ON quotas_daily(user_ref, day);
`);

export default db;

// Best-effort column migration for existing databases
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!info.find((c) => c.name === column)) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch {}
  }
}

addColumnIfMissing('receipts', 'first_token_ms', 'first_token_ms INTEGER');
addColumnIfMissing('receipts', 'task_id', 'task_id TEXT');
addColumnIfMissing('receipts', 'parent_id', 'parent_id TEXT');
addColumnIfMissing('receipts', 'reasons', 'reasons TEXT');

export function p95LatencyFor(model: string, n = 50): number | null {
  const rows = db
    .prepare(
      `SELECT latency_ms FROM traces WHERE route_final=? ORDER BY ts DESC LIMIT ?`
    )
    .all(model, n) as { latency_ms: number }[];
  if (!rows.length) return null;
  const arr = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  return arr[Math.floor(0.95 * (arr.length - 1))] ?? null;
}

export function fastestByRecentP95(models: string[], n = 50): string | null {
  let best: { m: string; p95: number } | null = null;
  for (const m of models) {
    const p95 = p95LatencyFor(m, n);
    if (p95 == null) continue;
    if (!best || p95 < best.p95) best = { m, p95 };
  }
  return best?.m ?? null;
}
