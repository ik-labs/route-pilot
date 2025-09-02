import crypto from "node:crypto";
import { getAgentSpec } from "./registry.js";
import { TaskEnvelope } from "./types.js";
import { loadPolicy } from "../policy.js";
import { runWithFallback } from "../router.js";
import { streamSSEToBufferAndStdout } from "../util/stream.js";
import { writeReceipt } from "../receipts.js";
import db from "../db.js";
import { estimateCost } from "../rates.js";
import { safeLastJson } from "../util/json.js";
import { validateAgainstSchema } from "./validate.js";

function uuid() { return crypto.randomUUID(); }

export async function runSubAgent<I, O>(env: TaskEnvelope<I, O>) {
  const spec = getAgentSpec(env.agent);
  const policy = await loadPolicy(spec.policy);

  const system = spec.system ?? `You are ${spec.name}. Output strictly JSON that matches the expected schema. Do not include markdown fences.`;

  // Validate input against declared schema (fail fast)
  const vin = validateAgainstSchema(spec.input_schema as any, env.input);
  if (!vin.ok) {
    throw new Error(
      `Input schema validation failed for ${spec.name}: ${vin.errors.join('; ')}`
    );
  }
  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ input: env.input, context: env.context ?? {}, constraints: env.constraints ?? {} }) },
  ];

  let captured = "";
  const handler = async (res: Response, onFirstChunk: () => void) => {
    captured = await streamSSEToBufferAndStdout(res, onFirstChunk);
  };

  if (process.stderr.isTTY) {
    process.stderr.write(`\n=== ${env.agent} (policy=${spec.policy}) ===\n`);
  }

  const { routeFinal, fallbackCount, latency, firstTokenMs, reasons } = await runWithFallback(
    { primary: policy.routing.primary, backups: policy.routing.backups },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages as any,
    Math.min(env.budget.tokens, policy.objectives.max_tokens ?? env.budget.tokens),
    Math.min(env.budget.timeMs, policy.strategy.fallback_on_latency_ms ?? env.budget.timeMs),
    policy.strategy.max_attempts,
    policy.strategy.backoff_ms,
    policy.strategy.first_chunk_gate_ms,
    { ...(policy.gen || {}), json_mode: true },
    handler,
    false
  );

  // TODO: real usage metering; use estimates for now
  const usage = { prompt: 300, completion: 200 };
  const cost = estimateCost(routeFinal, usage.prompt, usage.completion);
  const rid = writeReceipt({
    policy: policy.policy,
    route_primary: policy.routing.primary[0],
    route_final: routeFinal,
    fallback_count: fallbackCount,
    latency_ms: latency,
    usage: { prompt: usage.prompt, completion: usage.completion, cost },
    task_id: env.taskId,
    parent_id: env.parentId,
    first_token_ms: firstTokenMs ?? null,
    reasons,
    // extra metadata (stored in payload_json for timeline rendering)
    // not indexed: safe to add without DB migrations
    ...(env.agent ? { agent: env.agent } : {}),
    extras: env.receiptExtras,
  });

  // Record trace to support p95-based routing pre-pick for sub-agent models
  db.prepare(
    `INSERT INTO traces(id, ts, user_ref, policy, route_primary, route_final, latency_ms, tokens, cost_usd)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    rid,
    new Date().toISOString(),
    null,
    policy.policy,
    policy.routing.primary[0],
    routeFinal,
    latency,
    usage.prompt + usage.completion,
    cost
  );

  const json = safeLastJson(captured) as O;
  // Light schema validation (warn only)
  const v = validateAgainstSchema(spec.output_schema as any, json);
  if (!v.ok) {
    const msg = `[validate] ${spec.name} output schema warnings: ${v.errors.join("; ")}`;
    process.stderr.write(`\n${msg}\n`);
  }
  return { receiptId: rid, output: json, model: routeFinal, latencyMs: latency, costUsd: cost };
}

export async function helpdeskChain(text: string) {
  const taskId = uuid();
  // 1) Triage
  const triage = await runSubAgent<{ text: string }, { intent: string; fields?: string[] }>({
    envelopeVersion: "1",
    taskId,
    agent: "TriageAgent",
    policy: "balanced-helpdesk",
    budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 },
    input: { text },
  });

  // 2) Retrieval (optional)
  let records: any = { records: [] };
  if (triage.output?.fields?.length) {
    const ids = triage.output.fields;
    const ret = await runSubAgent<{ ids: string[] }, { records: any[] }>({
      envelopeVersion: "1",
      taskId,
      parentId: triage.receiptId,
      agent: "RetrieverAgent",
      policy: "cheap-fast",
      budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 },
      input: { ids },
    });
    records = ret.output;
    // 3) Writer, parent is retrieval receipt if present
    const writer = await runSubAgent<{ context: any; tone: string }, { draft: string }>({
      envelopeVersion: "1",
      taskId,
      parentId: ret.receiptId,
      agent: "WriterAgent",
      policy: "premium-brief",
      budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 },
      input: { context: { text, triage: triage.output, records }, tone: "friendly" },
    });
    return { taskId, draft: writer.output.draft, triage: triage.output, records };
  }

  // No retrieval, writer parent is triage receipt
  const writer = await runSubAgent<{ context: any; tone: string }, { draft: string }>({
    envelopeVersion: "1",
    taskId,
    parentId: triage.receiptId,
    agent: "WriterAgent",
    policy: "premium-brief",
    budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 },
    input: { context: { text, triage: triage.output, records }, tone: "friendly" },
  });

  return { taskId, draft: writer.output.draft, triage: triage.output, records };
}

export async function helpdeskParallelChain(text: string) {
  const taskId = uuid();
  // 1) Triage
  const triage = await runSubAgent<{ text: string }, { intent: string; fields?: string[] }>({
    envelopeVersion: "1",
    taskId,
    agent: "TriageAgent",
    policy: "balanced-helpdesk",
    budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 },
    input: { text },
  });

  let aggregated: any = { records: [] };
  if (triage.output?.fields?.length) {
    const ids = triage.output.fields;
    // 2) Fan-out: Fast + Accurate retrievers
    const branches = await runFanOut(taskId, triage.receiptId!, [
      { agent: "RetrieverFast",     input: { ids }, budget: { tokens: 500, costUsd: 0.0015, timeMs: 900 } },
      { agent: "RetrieverAccurate", input: { ids }, budget: { tokens: 600, costUsd: 0.0020, timeMs: 1200 } },
    ]);
    // 3) Aggregator
    const agg = await reduceFanOut(
      taskId,
      triage.receiptId!,
      "AggregatorAgent",
      branches.map((b) => ({ receiptId: b.receiptId!, output: b.output })),
      { tokens: 600, costUsd: 0.002, timeMs: 900 },
      { ids }
    );
    aggregated = agg.output;
  }

  // 4) Writer
  const writer = await runSubAgent<{ context: any; tone: string }, { draft: string }>({
    envelopeVersion: "1",
    taskId,
    parentId: triage.receiptId,
    agent: "WriterAgent",
    policy: "premium-brief",
    budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 },
    input: { context: { text, triage: triage.output, records: aggregated }, tone: "friendly" },
  });

  return { taskId, draft: writer.output.draft, triage: triage.output, records: aggregated };
}

// Helper: run multiple sub-agents in parallel with correct parent links
export async function runFanOut(
  taskId: string,
  parentReceiptId: string,
  branches: Array<{
    agent: string;
    input: any;
    budget: { tokens: number; costUsd: number; timeMs: number };
    context?: Record<string, any>;
    constraints?: Record<string, any>;
  }>
) {
  const results = await Promise.all(
    branches.map((b) =>
      runSubAgent({
        envelopeVersion: "1",
        taskId,
        parentId: parentReceiptId,
        agent: b.agent,
        policy: "", // resolved by registry in runSubAgent
        budget: b.budget,
        input: b.input,
        context: b.context,
        constraints: b.constraints,
      })
    )
  );
  return results;
}

// Helper: reduce fan-out outputs with an aggregator agent
export async function reduceFanOut(
  taskId: string,
  parentReceiptId: string,
  aggregatorAgent: string,
  branches: Array<{ receiptId: string; output: any }>,
  budget: { tokens: number; costUsd: number; timeMs: number },
  context: Record<string, any> = {}
) {
  const agg = await runSubAgent({
    envelopeVersion: "1",
    taskId,
    parentId: parentReceiptId,
    agent: aggregatorAgent,
    policy: "",
    budget,
    input: { branches: branches.map((b) => b.output), context },
    receiptExtras: { children_receipts: branches.map((b) => b.receiptId) },
  });
  return agg;
}
