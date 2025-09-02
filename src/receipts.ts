import crypto from "node:crypto";
import fs from "node:fs";
import db from "./db.js";

export type ReceiptInput = {
  policy: string;
  route_primary: string;
  route_final: string;
  fallback_count: number;
  latency_ms: number;
  usage: { prompt: number; completion: number; cost: number };
  mirrorJson?: boolean;
  task_id?: string;
  parent_id?: string;
  first_token_ms?: number | null;
  reasons?: string[];
};

export function writeReceipt(data: ReceiptInput) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const payload = { id, ts, ...data };
  const signature = sign(payload);

  db.prepare(
    `INSERT INTO receipts(id, ts, policy, route_primary, route_final, fallback_count, latency_ms, first_token_ms, task_id, parent_id, reasons, prompt_tokens, completion_tokens, cost_usd, signature, payload_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    ts,
    data.policy,
    data.route_primary,
    data.route_final,
    data.fallback_count,
    data.latency_ms,
    data.first_token_ms ?? null,
    data.task_id ?? null,
    data.parent_id ?? null,
    data.reasons ? JSON.stringify(data.reasons) : null,
    data.usage.prompt,
    data.usage.completion,
    data.usage.cost,
    signature,
    JSON.stringify(payload)
  );

  if (process.env.ROUTEPILOT_MIRROR_JSON === "1" || data.mirrorJson) {
    fs.mkdirSync("data/receipts", { recursive: true });
    fs.writeFileSync(`data/receipts/${id}.json`, JSON.stringify({ ...payload, signature }, null, 2));
  }

  return id;
}

function sign(obj: any) {
  const secret = process.env.JWT_SECRET ?? "dev-secret";
  const h = crypto.createHmac("sha256", secret);
  h.update(JSON.stringify(obj));
  return h.digest("hex");
}

export function getReceipt(id: string) {
  return db
    .prepare(
      `SELECT id, ts, policy, route_primary, route_final, fallback_count, latency_ms, first_token_ms, task_id, parent_id, reasons, prompt_tokens, completion_tokens, cost_usd, signature, payload_json
       FROM receipts WHERE id=?`
    )
    .get(id);
}

export function listReceipts(limit = 20) {
  return db
    .prepare(
      `SELECT id, ts, policy, route_final, latency_ms, cost_usd FROM receipts ORDER BY ts DESC LIMIT ?`
    )
    .all(limit);
}

export function timelineForTask(taskId: string) {
  const rows = db
    .prepare(
      `SELECT id, ts, policy, route_primary, route_final, fallback_count, latency_ms, first_token_ms, task_id, parent_id, reasons, prompt_tokens, completion_tokens, cost_usd, payload_json
       FROM receipts WHERE task_id=? ORDER BY ts ASC`
    )
    .all(taskId) as Array<{
      id: string; ts: string; policy: string; route_primary: string | null; route_final: string | null;
      fallback_count: number; latency_ms: number | null; first_token_ms: number | null;
      task_id: string | null; parent_id: string | null; reasons: string | null;
      prompt_tokens: number | null; completion_tokens: number | null; cost_usd: number | null; payload_json: string | null;
    }>;
  return rows.map((r) => {
    let agent: string | undefined;
    try {
      if (r.payload_json) {
        const p = JSON.parse(r.payload_json);
        agent = p.agent;
      }
    } catch {}
    let reasons: string[] | undefined;
    try { reasons = r.reasons ? JSON.parse(r.reasons) : undefined; } catch {}
    return {
      id: r.id,
      ts: r.ts,
      agent: agent ?? null,
      policy: r.policy,
      route: r.route_final,
      latency_ms: r.latency_ms,
      first_token_ms: r.first_token_ms,
      fallbacks: r.fallback_count,
      reasons,
      cost_usd: r.cost_usd,
      parent_id: r.parent_id,
    };
  });
}
