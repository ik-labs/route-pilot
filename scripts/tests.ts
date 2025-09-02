#!/usr/bin/env tsx
import assert from "node:assert";
import crypto from "node:crypto";
import { loadPolicy } from "../src/policy.js";
import db, { p95LatencyFor } from "../src/db.js";
import { assertWithinRpm } from "../src/quotas.js";
import { parseUsageFromHeaders } from "../src/util/usage.js";
import { writeReceipt, getReceipt } from "../src/receipts.js";

function hmacSha256Hex(text: string, secret = process.env.JWT_SECRET ?? "dev-secret") {
  const h = crypto.createHmac("sha256", secret);
  h.update(text);
  return h.digest("hex");
}

async function testPolicyParsing() {
  const p = await loadPolicy("advanced-controls");
  assert(p.routing.params && p.routing.params["openai/gpt-4o-mini"], "routing.params parsed");
  assert(p.strategy.first_chunk_gate_ms >= 0, "strategy gate present");
}

function testP95Calc() {
  const model = "test/model";
  // Insert synthetic traces
  const base = Date.now();
  const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  for (let i = 0; i < latencies.length; i++) {
    db.prepare(
      `INSERT INTO traces(id, ts, user_ref, policy, route_primary, route_final, latency_ms, tokens, cost_usd)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(crypto.randomUUID(), new Date(base - i * 1000).toISOString(), "tester", "test", model, model, latencies[i], 0, 0);
  }
  const p95 = p95LatencyFor(model, 10);
  assert(p95 !== null && p95 >= 900, `p95 looks reasonable: ${p95}`);
}

function testRpmGate() {
  const user = "tester-rpm";
  const limit = 3;
  // Clear old events
  db.prepare("DELETE FROM rpm_events WHERE user_ref=?").run(user);
  assert.doesNotThrow(() => { for (let i = 0; i < limit; i++) assertWithinRpm(user, limit); }, "within limit ok");
  assert.throws(() => assertWithinRpm(user, limit), (e: any) => e?.tag === "QUOTA" && e.kind === "rpm", "exceeds limit throws");
}

function testReceiptSigner() {
  const rid = writeReceipt({
    policy: "test",
    route_primary: "a",
    route_final: "a",
    fallback_count: 0,
    latency_ms: 123,
    usage: { prompt: 1, completion: 2, cost: 0.0001 },
  });
  const row: any = getReceipt(rid);
  const payload = row.payload_json as string;
  const expected = hmacSha256Hex(payload);
  assert.strictEqual(row.signature, expected, "receipt signature matches HMAC of payload");
}

function testUsageHeaders() {
  const h = new Headers();
  h.set("x-usage-prompt-tokens", "123");
  h.set("x-usage-completion-tokens", "45");
  const u = parseUsageFromHeaders(h)!;
  assert(u && u.prompt === 123 && u.completion === 45, "usage parsed from headers");
}

async function main() {
  await testPolicyParsing();
  testP95Calc();
  testRpmGate();
  testReceiptSigner();
  testUsageHeaders();
  console.log("tests OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
