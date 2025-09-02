import { helpdeskChain, helpdeskParallelChain, helpdeskHttpChain } from "./controller.js";
import crypto from "node:crypto";
import { getAgentSpec } from "./registry.js";
import { loadPolicy } from "../policy.js";
import { runWithFallback } from "../router.js";
import { streamSSEToVoid } from "../util/stream.js";
import { estimateCost } from "../rates.js";

export async function runChain(name: string, opts: { text?: string; earlyStop?: boolean }) {
  if (!opts.text) throw new Error("--text is required");
  if (name === "helpdesk") return helpdeskChain(opts.text);
  if (name === "helpdesk-par" || name === "helpdesk-parallel") return helpdeskParallelChain(opts.text, { earlyStop: !!opts.earlyStop });
  if (name === "helpdesk-http") return helpdeskHttpChain(opts.text);
  throw new Error(`Unknown chain '${name}' (supported: helpdesk, helpdesk-par)`);
}

export async function planChain(name: string, opts: { text?: string }) {
  if (name === "helpdesk") {
    return [
      { step: 1, agent: "TriageAgent", policy: "balanced-helpdesk", budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 } },
      { step: 2, agent: "RetrieverAgent", policy: "cheap-fast", budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 }, conditional: "if triage.fields non-empty" },
      { step: 3, agent: "WriterAgent", policy: "premium-brief", budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 } },
    ];
  }
  if (name === "helpdesk-par" || name === "helpdesk-parallel") {
    return [
      { step: 1, agent: "TriageAgent", policy: "balanced-helpdesk", budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 } },
      { step: 2, agent: "RetrieverFast", policy: "cheap-fast", budget: { tokens: 500, costUsd: 0.0015, timeMs: 900 }, parallel: true, branch: "A", conditional: "if triage.fields non-empty" },
      { step: 2, agent: "RetrieverAccurate", policy: "balanced-helpdesk", budget: { tokens: 600, costUsd: 0.0020, timeMs: 1200 }, parallel: true, branch: "B" },
      { step: 3, agent: "AggregatorAgent", policy: "cheap-fast", budget: { tokens: 600, costUsd: 0.002, timeMs: 900 } },
      { step: 4, agent: "WriterAgent", policy: "premium-brief", budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 } },
    ];
  }
  if (name === "helpdesk-http") {
    return [
      { step: 1, agent: "TriageAgent", policy: "balanced-helpdesk", budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 } },
      { step: 2, agent: "RetrieverAgent", policy: "cheap-fast", budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 }, note: "http_fetch tool used with URL template" },
      { step: 3, agent: "WriterAgent", policy: "premium-brief", budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 } },
    ];
  }
  throw new Error(`Unknown chain '${name}' (supported: helpdesk, helpdesk-par)`);
}

async function evaluateAgentOnModel(
  agentName: string,
  input: any,
  budget: { tokens: number; costUsd: number; timeMs: number },
  context: Record<string, any> | undefined,
  constraints: Record<string, any> | undefined,
  forceModel: string
) {
  const spec = getAgentSpec(agentName);
  const policy = await loadPolicy(spec.policy);
  const system = spec.system ?? `You are ${spec.name}. Output strictly JSON that matches the expected schema.`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ input, context: context ?? {}, constraints: constraints ?? {} }) },
  ];
  const { latency, usagePrompt, usageCompletion, routeFinal } = await runWithFallback(
    { primary: [forceModel], backups: [] },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages as any,
    Math.min(budget.tokens, policy.objectives.max_tokens ?? budget.tokens),
    Math.min(budget.timeMs, policy.strategy.fallback_on_latency_ms ?? budget.timeMs),
    1,
    [0],
    policy.strategy.first_chunk_gate_ms,
    policy.strategy.escalate_after_fallbacks,
    { ...(policy.gen || {}), json_mode: true },
    async (res, onFirst) => { await streamSSEToVoid(res, onFirst); },
    false
  );
  const prompt = usagePrompt ?? 300;
  const completion = usageCompletion ?? 200;
  const cost = estimateCost(routeFinal, prompt, completion);
  return { model: routeFinal, latency_ms: latency, prompt_tokens: prompt, completion_tokens: completion, cost_usd: Number(cost.toFixed(6)) };
}

export async function replayRetrievers(name: string, opts: { text?: string; alts?: string[] }) {
  if (!opts.text) throw new Error("--text is required");
  const text = opts.text;
  // Run triage to obtain fields/ids context
  const triage = await (await import("./controller.js")).runSubAgent<{ text: string }, { intent: string; fields?: string[] }>({
    envelopeVersion: "1",
    taskId: crypto.randomUUID(),
    agent: "TriageAgent",
    policy: "balanced-helpdesk",
    budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 },
    input: { text },
  } as any);
  const ids = triage.output?.fields || [];
  const alts = (opts.alts || []).filter(Boolean);
  const out: any = { triage: triage.output, comparisons: [] };

  if (name === "helpdesk" || name === "helpdesk-http") {
    const spec = getAgentSpec("RetrieverAgent");
    const policy = await loadPolicy(spec.policy);
    const baseline = policy.routing.primary[0];
    const models = [baseline, ...alts.filter((m) => m !== baseline)];
    const evals = [] as any[];
    for (const m of models) {
      evals.push(await evaluateAgentOnModel("RetrieverAgent", { ids }, { tokens: 600, costUsd: 0.002, timeMs: 1000 }, undefined, undefined, m));
    }
    out.comparisons.push({ agent: "RetrieverAgent", results: evals });
    // Also compare Writer using baseline records
    const { runSubAgent } = await import("./controller.js");
    const baseRet = await runSubAgent<{ ids: string[] }, { records: any[] }>({
      envelopeVersion: "1",
      taskId: crypto.randomUUID(),
      agent: "RetrieverAgent",
      policy: "cheap-fast",
      budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 },
      input: { ids },
    } as any);
    const context = { text, triage: triage.output, records: baseRet.output };
    const specW = getAgentSpec("WriterAgent");
    const policyW = await loadPolicy(specW.policy);
    const baselineW = policyW.routing.primary[0];
    const modelsW = [baselineW, ...alts.filter((m) => m !== baselineW)];
    const evalsW: any[] = [];
    for (const m of modelsW) {
      evalsW.push(await evaluateAgentOnModel("WriterAgent", { context, tone: "friendly" }, { tokens: 1200, costUsd: 0.006, timeMs: 1500 }, undefined, undefined, m));
    }
    out.comparisons.push({ agent: "WriterAgent", results: evalsW });
    return out;
  }
  if (name === "helpdesk-par" || name === "helpdesk-parallel") {
    for (const agentName of ["RetrieverFast", "RetrieverAccurate"]) {
      const spec = getAgentSpec(agentName);
      const policy = await loadPolicy(spec.policy);
      const baseline = policy.routing.primary[0];
      const models = [baseline, ...alts.filter((m) => m !== baseline)];
      const evals = [] as any[];
      for (const m of models) {
        evals.push(await evaluateAgentOnModel(agentName, { ids }, { tokens: 600, costUsd: 0.002, timeMs: 1200 }, undefined, undefined, m));
      }
      out.comparisons.push({ agent: agentName, results: evals });
    }
    // Compare Aggregator using baseline retriever outputs
    const { runSubAgent } = await import("./controller.js");
    const baseA = await runSubAgent<{ ids: string[] }, { records: any[] }>({
      envelopeVersion: "1",
      taskId: crypto.randomUUID(),
      agent: "RetrieverFast",
      policy: "cheap-fast",
      budget: { tokens: 500, costUsd: 0.0015, timeMs: 900 },
      input: { ids },
    } as any);
    const baseB = await runSubAgent<{ ids: string[] }, { records: any[] }>({
      envelopeVersion: "1",
      taskId: crypto.randomUUID(),
      agent: "RetrieverAccurate",
      policy: "balanced-helpdesk",
      budget: { tokens: 600, costUsd: 0.0020, timeMs: 1200 },
      input: { ids },
    } as any);
    const branches = [baseA.output, baseB.output];
    const specAgg = getAgentSpec("AggregatorAgent");
    const policyAgg = await loadPolicy(specAgg.policy);
    const baselineAgg = policyAgg.routing.primary[0];
    const modelsAgg = [baselineAgg, ...alts.filter((m) => m !== baselineAgg)];
    const evalsAgg: any[] = [];
    for (const m of modelsAgg) {
      evalsAgg.push(await evaluateAgentOnModel("AggregatorAgent", { branches, context: { ids } }, { tokens: 600, costUsd: 0.002, timeMs: 900 }, undefined, undefined, m));
    }
    out.comparisons.push({ agent: "AggregatorAgent", results: evalsAgg });
    // Optionally compare Writer using aggregated result
    const context = { text, triage: triage.output, records: evalsAgg[0] ? branches[0] : { records: [] } };
    const specW = getAgentSpec("WriterAgent");
    const policyW = await loadPolicy(specW.policy);
    const baselineW = policyW.routing.primary[0];
    const modelsW = [baselineW, ...alts.filter((m) => m !== baselineW)];
    const evalsW: any[] = [];
    for (const m of modelsW) {
      evalsW.push(await evaluateAgentOnModel("WriterAgent", { context, tone: "friendly" }, { tokens: 1200, costUsd: 0.006, timeMs: 1500 }, undefined, undefined, m));
    }
    out.comparisons.push({ agent: "WriterAgent", results: evalsW });
    return out;
  }
  throw new Error(`Unknown chain '${name}' (supported: helpdesk, helpdesk-par, helpdesk-http)`);
}
