import crypto from "node:crypto";
import { getAgentSpec } from "./registry.js";
import { TaskEnvelope } from "./types.js";
import { loadPolicy } from "../policy.js";
import { runWithFallback } from "../router.js";
import { streamSSEToBufferAndStdout } from "../util/stream.js";
import { writeReceipt } from "../receipts.js";
import { estimateCost } from "../rates.js";
import { safeLastJson } from "../util/json.js";

function uuid() { return crypto.randomUUID(); }

export async function runSubAgent<I, O>(env: TaskEnvelope<I, O>) {
  const spec = getAgentSpec(env.agent);
  const policy = await loadPolicy(spec.policy);

  const system = `You are ${spec.name}. Output strictly JSON that matches the expected schema. Do not include markdown fences.`;
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
  writeReceipt({
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
  });

  const json = safeLastJson(captured) as O;
  return { output: json, model: routeFinal, latencyMs: latency, costUsd: cost };
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
      parentId: taskId,
      agent: "RetrieverAgent",
      policy: "cheap-fast",
      budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 },
      input: { ids },
    });
    records = ret.output;
  }

  // 3) Writer
  const writer = await runSubAgent<{ context: any; tone: string }, { draft: string }>({
    envelopeVersion: "1",
    taskId,
    parentId: taskId,
    agent: "WriterAgent",
    policy: "premium-brief",
    budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 },
    input: { context: { text, triage: triage.output, records }, tone: "friendly" },
  });

  return { taskId, draft: writer.output.draft, triage: triage.output, records };
}
