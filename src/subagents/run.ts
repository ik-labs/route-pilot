import { helpdeskChain } from "./controller.js";

export async function runChain(name: string, opts: { text?: string }) {
  if (name !== "helpdesk") throw new Error(`Unknown chain '${name}' (supported: helpdesk)`);
  if (!opts.text) throw new Error("--text is required for helpdesk chain");
  return helpdeskChain(opts.text);
}

export async function planChain(name: string, opts: { text?: string }) {
  if (name !== "helpdesk") throw new Error(`Unknown chain '${name}' (supported: helpdesk)`);
  // Static plan for now; budgets as in controller
  return [
    { step: 1, agent: "TriageAgent", policy: "balanced-helpdesk", budget: { tokens: 800, costUsd: 0.002, timeMs: 1200 } },
    { step: 2, agent: "RetrieverAgent", policy: "cheap-fast", budget: { tokens: 600, costUsd: 0.002, timeMs: 1000 }, conditional: "if triage.fields non-empty" },
    { step: 3, agent: "WriterAgent", policy: "premium-brief", budget: { tokens: 1200, costUsd: 0.006, timeMs: 1500 } },
  ];
}

