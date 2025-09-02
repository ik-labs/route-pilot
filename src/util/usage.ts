export type UsageCounts = { prompt?: number; completion?: number; total?: number };
import { callGateway, ChatParams } from "../gateway.js";

function parseIntSafe(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

// Best-effort parser for provider/Gateway usage headers.
// Looks for common header names and also scans any header with 'tokens'.
export function parseUsageFromHeaders(h: Headers): UsageCounts | null {
  // Known candidates (case-insensitive)
  const candidates = [
    // Hypothetical/Gateway
    ["x-usage-prompt-tokens", "x-usage-completion-tokens", "x-usage-total-tokens"],
    ["vercel-ai-prompt-tokens", "vercel-ai-completion-tokens", "vercel-ai-total-tokens"],
    // OpenAI-like (if ever exposed)
    ["openai-prompt-tokens", "openai-completion-tokens", "openai-total-tokens"],
  ];

  for (const [p, c, t] of candidates) {
    const prompt = parseIntSafe(h.get(p));
    const completion = parseIntSafe(h.get(c));
    const total = parseIntSafe(h.get(t));
    if (prompt != null || completion != null || total != null) {
      return { prompt: prompt ?? undefined, completion: completion ?? undefined, total: total ?? undefined };
    }
  }

  // Generic scan: any header containing 'tokens'
  let prompt: number | undefined; let completion: number | undefined; let total: number | undefined;
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!/tokens/.test(k)) return;
    const n = parseIntSafe(value);
    if (!Number.isFinite(n as number)) return;
    if (/prompt/.test(k)) prompt = n;
    else if (/completion/.test(k)) completion = n;
    else if (/total/.test(k)) total = n;
  });
  if (prompt != null || completion != null || total != null) return { prompt, completion, total };
  return null;
}

// Best-effort usage probe via non-stream JSON response. Returns usage counts when available.
export async function probeUsageFromJSON(call: Omit<ChatParams, "stream"> & { stream?: false }): Promise<UsageCounts | null> {
  const res = await callGateway({ ...call, stream: false });
  if (!res.ok) return null;
  try {
    const obj: any = await res.json();
    const u = obj?.usage;
    if (!u) return null;
    const out: UsageCounts = {};
    if (typeof u.prompt_tokens === 'number') out.prompt = u.prompt_tokens;
    if (typeof u.completion_tokens === 'number') out.completion = u.completion_tokens;
    if (typeof u.total_tokens === 'number') out.total = u.total_tokens;
    return out.prompt != null || out.completion != null || out.total != null ? out : null;
  } catch {
    return null;
  }
}
