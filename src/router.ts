import { callGateway, ChatParams } from "./gateway.js";
import { streamToStdout } from "./util/stream.js";
import { fastestByRecentP95, p95LatencyFor } from "./db.js";

type RoutePlan = { primary: string[]; backups: string[] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWithFallback(
  plan: RoutePlan,
  targetP95: number,
  p95WindowN: number,
  messages: any[],
  maxTokens: number,
  fallbackOnMs: number,
  maxAttempts: number,
  backoffMs: number[],
  gen?: { temperature?: number; top_p?: number; stop?: string[]; json_mode?: boolean },
  streamHandler?: (res: Response, onFirstChunk: () => void) => Promise<void>
) {
  const primaryModel = plan.primary[0];
  const recentP95 = p95LatencyFor(primaryModel, p95WindowN);
  const fastestBackup = fastestByRecentP95(plan.backups, p95WindowN);
  const startList =
    recentP95 != null && recentP95 > targetP95 && fastestBackup
      ? [fastestBackup, ...plan.primary, ...plan.backups.filter((b) => b !== fastestBackup)]
      : [...plan.primary, ...plan.backups];

  const tries = startList;
  let used: string[] = [];
  let start = Date.now();
  let routeFinal = "";
  let fallbackCount = 0;

  let attempts = 0;
  for (const model of tries) {
    if (attempts >= maxAttempts) break;
    attempts++;
    const ac = new AbortController();
    const stallTimer = setTimeout(() => ac.abort(), fallbackOnMs);

    try {
      const call: ChatParams = { model, messages, max_tokens: maxTokens, stream: true };
      if (gen?.temperature !== undefined) call.temperature = gen.temperature;
      if (gen?.top_p !== undefined) call.top_p = gen.top_p;
      if (gen?.stop) call.stop = gen.stop;
      if (gen?.json_mode) call.response_format = { type: "json_object" };
      const res = await callGateway(call, ac.signal);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      let firstChunkSeen = false;
      const firstChunkTimer = setTimeout(() => {
        if (!firstChunkSeen) {
          ac.abort();
        }
      }, fallbackOnMs);

      const handler = streamHandler ?? streamToStdout;
      await handler(res, () => {
        firstChunkSeen = true;
      });

      clearTimeout(firstChunkTimer);
      clearTimeout(stallTimer);
      routeFinal = model;
      break; // success
    } catch (e) {
      fallbackCount++;
      used.push(model);
      const backoff = backoffMs[Math.min(fallbackCount - 1, backoffMs.length - 1)] ?? 100;
      await sleep(backoff);
      continue;
    }
  }

  const latency = Date.now() - start;
  if (!routeFinal) throw new Error(`All routes failed after ${tries.length} attempts`);

  return { routeFinal, fallbackCount, latency };
}
