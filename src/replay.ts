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

