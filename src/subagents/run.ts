import { helpdeskChain, helpdeskParallelChain } from "./controller.js";

export async function runChain(name: string, opts: { text?: string }) {
  if (!opts.text) throw new Error("--text is required");
  if (name === "helpdesk") return helpdeskChain(opts.text);
  if (name === "helpdesk-par" || name === "helpdesk-parallel") return helpdeskParallelChain(opts.text);
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
  throw new Error(`Unknown chain '${name}' (supported: helpdesk, helpdesk-par)`);
}
