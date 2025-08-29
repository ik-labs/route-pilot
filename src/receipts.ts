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
};

export function writeReceipt(data: ReceiptInput) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const payload = { id, ts, ...data };
  const signature = sign(payload);

  db.prepare(
    `INSERT INTO receipts(id, ts, policy, route_primary, route_final, fallback_count, latency_ms, prompt_tokens, completion_tokens, cost_usd, signature, payload_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    ts,
    data.policy,
    data.route_primary,
    data.route_final,
    data.fallback_count,
    data.latency_ms,
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
      `SELECT id, ts, policy, route_primary, route_final, fallback_count, latency_ms, prompt_tokens, completion_tokens, cost_usd, signature, payload_json
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
