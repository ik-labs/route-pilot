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
import { httpFetch } from "./tools/http_fetch.js";
import { sha256Hex } from "../util/hash.js";

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
  // Optional tool: http_fetch — run before LLM and attach results to payload
  let tool_results: any = undefined;
  try {
    if (spec.tools?.includes("http_fetch")) {
      const ids = (env as any).input?.ids as string[] | undefined;
      const urlTemplate = (env.context as any)?.http_fetch?.url_template || process.env.HTTP_FETCH_URL_TEMPLATE;
      if (ids && ids.length && typeof urlTemplate === 'string' && urlTemplate.includes('{id}')) {
        const allowHosts = (process.env.HTTP_FETCH_ALLOWLIST || '').split(/\s*,\s*/).filter(Boolean);
        const envMax = parseInt(process.env.HTTP_FETCH_MAX || '3', 10);
        const cap = Number.isFinite(envMax) && envMax > 0 ? envMax : 3;
        const maxFetch = Math.min(ids.length, cap); // cap for safety
        const fetched: any[] = [];
        for (let i = 0; i < maxFetch; i++) {
          const id = ids[i];
          const url = urlTemplate.replaceAll('{id}', encodeURIComponent(id));
          try {
            const res = await httpFetch(url, { allowHosts });
            let parsed: any = undefined;
            if (res.body && (res.headers['content-type'] || '').startsWith('application/json')) {
              try { parsed = JSON.parse(res.body); } catch {}
            }
            const body = res.body ? (res.body.length > 5000 ? (res.body.slice(0, 5000) + '\n...[truncated]') : res.body) : undefined;
            fetched.push({ id, url, status: res.status, json: parsed, body });
          } catch (e: any) {
            fetched.push({ id, url, error: e?.message || String(e) });
          }
        }
        tool_results = { http_fetch: fetched };
      }
    }
  } catch {}

  const userPayloadObj: any = { input: env.input, context: env.context ?? {}, constraints: env.constraints ?? {} };
  if (tool_results) userPayloadObj.tool_results = tool_results;
  const userPayload = JSON.stringify(userPayloadObj);
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userPayload },
  ];

  let captured = "";
  const handler = async (res: Response, onFirstChunk: () => void) => {
    captured = await streamSSEToBufferAndStdout(res, onFirstChunk, env.agent);
  };

  if (process.stderr.isTTY) {
    process.stderr.write(`\n=== ${env.agent} (policy=${spec.policy}) ===\n`);
  }

  // Dry-run mode: validate only, no network calls or receipts
  if (process.env.ROUTEPILOT_DRY_RUN === '1') {
    const stub = createStubOutput(spec);
    return { receiptId: undefined, output: stub as O, model: 'dry-run', latencyMs: 0, costUsd: 0, fallbacks: 0, overBudget: false } as any;
  }

  const { routeFinal, fallbackCount, latency, firstTokenMs, reasons, usagePrompt, usageCompletion } = await runWithFallback(
    { primary: policy.routing.primary, backups: policy.routing.backups },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages as any,
    Math.min(env.budget.tokens, policy.objectives.max_tokens ?? env.budget.tokens),
    Math.min(env.budget.timeMs, policy.strategy.fallback_on_latency_ms ?? env.budget.timeMs),
    policy.strategy.max_attempts,
    policy.strategy.backoff_ms,
    policy.strategy.first_chunk_gate_ms,
    policy.strategy.escalate_after_fallbacks,
    { ...(policy.gen || {}), json_mode: true },
    policy.routing.params ?? undefined,
    handler,
    false
  );

  // Real usage from headers when available; fallback to estimate; optional usage probe
  let usage = { prompt: usagePrompt ?? 300, completion: usageCompletion ?? 200 };
  if (process.env.ROUTEPILOT_USAGE_PROBE === '1' && usagePrompt == null) {
    const perModel = (policy.routing.params || {})[routeFinal] || {};
    const merged = { ...(policy.gen || {}), ...perModel } as any;
    const { probeUsageFromJSON } = await import("../util/usage.js");
    const probe = await probeUsageFromJSON({ model: routeFinal, messages: messages as any, max_tokens: 1, ...(merged.temperature != null ? { temperature: merged.temperature } : {}), ...(merged.top_p != null ? { top_p: merged.top_p } : {}), ...(merged.stop ? { stop: merged.stop } : {}), ...(merged.json_mode ? { response_format: { type: "json_object" } } : {}) });
    if (probe?.prompt != null) usage.prompt = probe.prompt;
    if (usage.completion == null && probe?.completion != null) usage.completion = probe.completion;
  }
  const cost = estimateCost(routeFinal, usage.prompt, usage.completion);
  const overBudget = cost > (env.budget.costUsd ?? Infinity) || latency > env.budget.timeMs || fallbackCount >= 2;
  const includeSnapshot = process.env.ROUTEPILOT_SNAPSHOT_INPUT === '1';
  const rid = writeReceipt({
    policy: policy.policy,
    route_primary: policy.routing.primary[0],
    route_final: routeFinal,
    model_path: routeFinal,
    fallback_count: fallbackCount,
    latency_ms: latency,
    usage: { prompt: usage.prompt, completion: usage.completion, cost },
    task_id: env.taskId,
    parent_id: env.parentId,
    first_token_ms: firstTokenMs ?? null,
    reasons,
    prompt_hash: sha256Hex(userPayload),
    policy_hash: sha256Hex(JSON.stringify(policy)),
    // extra metadata (stored in payload_json for timeline rendering)
    // not indexed: safe to add without DB migrations
    extras: { ...(env.receiptExtras || {}), ...(includeSnapshot ? { input_snapshot: userPayload } : {}), ...(overBudget ? { over_budget: true } : {}) },
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
  return { receiptId: rid, output: json, model: routeFinal, latencyMs: latency, costUsd: cost, fallbacks: fallbackCount, overBudget } as any;
}

function createStubOutput(spec: ReturnType<typeof getAgentSpec>): any {
  const name = spec.name || '';
  if (/Triage/i.test(name)) return { intent: "dry-run", fields: [] };
  if (/Retriever/i.test(name)) return { records: [] };
  if (/Writer/i.test(name)) return { draft: "" };
  if (/Aggregator/i.test(name)) return { records: [] };
  return {};
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
  if (!('overBudget' in triage && (triage as any).overBudget) && (triage.output?.fields?.length)) {
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

export async function helpdeskParallelChain(text: string, opts?: { earlyStop?: boolean }) {
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
  if (!('overBudget' in triage && (triage as any).overBudget) && (triage.output?.fields?.length)) {
    const ids = triage.output.fields;
    // 2) Fan-out: Fast + Accurate retrievers
    const fan = await runFanOut(taskId, triage.receiptId!, [
      { agent: "RetrieverFast",     input: { ids }, budget: { tokens: 500, costUsd: 0.0015, timeMs: 900 } },
      { agent: "RetrieverAccurate", input: { ids }, budget: { tokens: 600, costUsd: 0.0020, timeMs: 1200 } },
    ], { earlyStop: opts?.earlyStop ?? (process.env.ROUTEPILOT_EARLY_STOP === '1') });
    const branches = fan.results;
    // 3) Aggregator
    const agg = await reduceFanOut(
      taskId,
      triage.receiptId!,
      "AggregatorAgent",
      branches.map((b) => ({ receiptId: b.receiptId!, output: b.output })),
      { tokens: 600, costUsd: 0.002, timeMs: 900 },
      { ids },
      fan.cancelledAgents
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

export async function helpdeskHttpChain(text: string) {
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

  // 2) Retrieval with http_fetch context
  let records: any = { records: [] };
  if (!('overBudget' in triage && (triage as any).overBudget) && (triage.output?.fields?.length)) {
    const ids = triage.output.fields;
    const urlTemplate = process.env.HTTP_FETCH_URL_TEMPLATE || "https://jsonplaceholder.typicode.com/posts/{id}";
    const ret = await runSubAgent<{ ids: string[] }, { records: any[] }>({
      envelopeVersion: "1",
      taskId,
      parentId: triage.receiptId,
      agent: "RetrieverAgent",
      policy: "cheap-fast",
      budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 },
      input: { ids },
      context: { http_fetch: { url_template: urlTemplate } },
    });
    records = ret.output;
    // 3) Writer
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
  }>,
  opts?: { earlyStop?: boolean }
) {
  const early = opts?.earlyStop ?? (process.env.ROUTEPILOT_EARLY_STOP === '1');
  if (!early) {
    const results = await Promise.all(
      branches.map((b) =>
        runSubAgent({ envelopeVersion: "1", taskId, parentId: parentReceiptId, agent: b.agent, policy: "", budget: b.budget, input: b.input, context: b.context, constraints: b.constraints })
      )
    );
    return { results, cancelledAgents: [] } as any;
  }
  const ctrls = branches.map(() => new AbortController());
  const proms = branches.map((b, i) => runSubAgent({ envelopeVersion: "1", taskId, parentId: parentReceiptId, agent: b.agent, policy: "", budget: b.budget, input: b.input, context: b.context, constraints: b.constraints, abortSignal: ctrls[i].signal }));
  const first = await Promise.race(proms.map((p, idx) => p.then(res => ({ res, idx }))));
  ctrls.forEach((c, i) => { if (i !== first.idx) try { c.abort(); } catch {} });
  await Promise.allSettled(proms);
  const cancelledAgents = branches.map((b, i) => i === first.idx ? undefined : b.agent).filter(Boolean) as string[];
  return { results: [first.res], cancelledAgents } as any;
}

// Helper: reduce fan-out outputs with an aggregator agent
export async function reduceFanOut(
  taskId: string,
  parentReceiptId: string,
  aggregatorAgent: string,
  branches: Array<{ receiptId: string; output: any }>,
  budget: { tokens: number; costUsd: number; timeMs: number },
  context: Record<string, any> = {},
  cancelledAgents?: string[]
) {
  const agg = await runSubAgent({
    envelopeVersion: "1",
    taskId,
    parentId: parentReceiptId,
    agent: aggregatorAgent,
    policy: "",
    budget,
    input: { branches: branches.map((b) => b.output), context },
    receiptExtras: { children_receipts: branches.map((b) => b.receiptId), ...(cancelledAgents?.length ? { cancelled_agents: cancelledAgents } : {}) },
  });
  return agg;
}
