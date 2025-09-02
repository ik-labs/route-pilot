import db from "./db.js";
import { loadPolicy } from "./policy.js";
import { runWithFallback } from "./router.js";
import { estimateCost } from "./rates.js";
import { streamSSEToVoid } from "./util/stream.js";

export async function replayPrompt(
  policyName: string,
  text: string,
  alts: string[]
) {
  const policy = await loadPolicy(policyName);
  const basePrimary = policy.routing.primary[0];
  const models = [basePrimary, ...alts.filter((m) => m && m !== basePrimary)];
  const messages = [{ role: "user", content: text }];
  if (policy.gen?.system) messages.unshift({ role: "system", content: policy.gen.system });

  const results: Array<{
    model: string;
    latency_ms: number;
    prompt_tokens: number;
    completion_tokens: number;
    cost_usd: number;
  }> = [];

  for (const model of models) {
    const { latency, usagePrompt, usageCompletion, routeFinal } = await runWithFallback(
      { primary: [model], backups: [] },
      policy.objectives.p95_latency_ms,
      policy.routing.p95_window_n,
      messages as any,
      Math.min(policy.objectives.max_tokens ?? 1024, 2048),
      policy.strategy.fallback_on_latency_ms ?? 1500,
      1,                     // attempts: measure the target model only
      [0],                   // no backoff needed
      policy.strategy.first_chunk_gate_ms,
      policy.gen ?? undefined,
      policy.routing.params ?? undefined,
      async (res, onFirst) => { await streamSSEToVoid(res, onFirst); },
      false
    );
    const prompt = usagePrompt ?? 300;
    const completion = usageCompletion ?? 200;
    const cost = estimateCost(routeFinal, prompt, completion);
    results.push({ model: routeFinal, latency_ms: latency, prompt_tokens: prompt, completion_tokens: completion, cost_usd: Number(cost.toFixed(6)) });
  }

  // Suggest backups sorted by latency (keep current primary as is)
  const sorted = [...results].sort((a, b) => a.latency_ms - b.latency_ms).map((r) => r.model);
  const suggestedBackups = sorted.filter((m) => m !== basePrimary);

  const suggestedPatch = {
    policy: policy.policy,
    routing: {
      primary: [basePrimary],
      backups: suggestedBackups,
    },
  };

  return { policy: policy.policy, primary: basePrimary, results, suggestedPatch };
}

type ReceiptRow = {
  id: string;
  ts: string;
  policy: string;
  payload_json: string | null;
};

function loadReceiptWithPayload(id: string): ReceiptRow | null {
  const row = db
    .prepare(`SELECT id, ts, policy, payload_json FROM receipts WHERE id=?`)
    .get(id) as ReceiptRow | undefined;
  return row || null;
}

function listRecentReceiptsWithPayload(limit: number): ReceiptRow[] {
  return db
    .prepare(`SELECT id, ts, policy, payload_json FROM receipts ORDER BY ts DESC LIMIT ?`)
    .all(limit) as ReceiptRow[];
}

function extractTextFromPayload(payload_json: string | null): string | null {
  if (!payload_json) return null;
  try {
    const p = JSON.parse(payload_json);
    // Prefer explicit snapshots when present
    if (p?.meta?.input_snapshot) return String(p.meta.input_snapshot);
    // No snapshot stored; cannot reconstruct exact prompt
    return null;
  } catch {
    return null;
  }
}

export async function replayFromReceipt(id: string, alts: string[], policyOverride?: string) {
  const row = loadReceiptWithPayload(id);
  if (!row) throw new Error(`No receipt ${id}`);
  const text = extractTextFromPayload(row.payload_json);
  if (!text) throw new Error(`Receipt ${id} has no input snapshot. Set ROUTEPILOT_SNAPSHOT_INPUT=1 before running to record snapshots.`);
  const policyName = policyOverride || row.policy;
  return replayPrompt(policyName, text, alts);
}

export async function replayLast(limit: number, alts: string[], policyOverride?: string) {
  const rows = listRecentReceiptsWithPayload(limit);
  const usable = rows
    .map((r) => ({ r, text: extractTextFromPayload(r.payload_json) }))
    .filter((x) => !!x.text) as Array<{ r: ReceiptRow; text: string }>;
  if (!usable.length) throw new Error(`No receipts with input snapshots. Set ROUTEPILOT_SNAPSHOT_INPUT=1 before running to record snapshots.`);
  const perPolicy = new Map<string, Array<{ id: string; text: string }>>();
  for (const u of usable) {
    const p = policyOverride || u.r.policy;
    const arr = perPolicy.get(p) || [];
    arr.push({ id: u.r.id, text: u.text });
    perPolicy.set(p, arr);
  }
  const outputs: any[] = [];
  for (const [policyName, items] of perPolicy.entries()) {
    for (const item of items) {
      const out = await replayPrompt(policyName, item.text, alts);
      outputs.push({ receipt: item.id, ...out });
    }
  }
  return { count: outputs.length, results: outputs };
}
