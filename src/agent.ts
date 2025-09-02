import crypto from "node:crypto";
import db from "./db.js";
import { loadAgent } from "./agents.js";
import { loadPolicy } from "./policy.js";
import { addDailyTokens, assertWithinRpm } from "./quotas.js";
import { estimateCost } from "./rates.js";
import { runWithFallback } from "./router.js";
import { streamSSEToBufferAndStdout } from "./util/stream.js";
import { buildAttachmentMessage, AttachOpts } from "./util/files.js";
import { writeReceipt } from "./receipts.js";
import { sha256Hex } from "./util/hash.js";

function uuid() { return crypto.randomUUID(); }

function createSession(userRef: string, agentName: string, policy: string) {
  const id = uuid();
  db.prepare(
    `INSERT INTO sessions(id, created_at, user_ref, agent, policy) VALUES(?,?,?,?,?)`
  ).run(id, new Date().toISOString(), userRef, agentName, policy);
  return id;
}

function getSession(sessionId: string) {
  return db.prepare(`SELECT * FROM sessions WHERE id=?`).get(sessionId);
}

function listMessages(sessionId: string, limit = 50) {
  return db
    .prepare(
      `SELECT role, content FROM messages WHERE session_id=? ORDER BY ts DESC LIMIT ?`
    )
    .all(sessionId, limit)
    .reverse() as { role: string; content: string }[];
}

function addMessage(sessionId: string, role: string, content: string) {
  db.prepare(
    `INSERT INTO messages(id, session_id, role, content, ts) VALUES(?,?,?,?,?)`
  ).run(uuid(), sessionId, role, content, new Date().toISOString());
}

export async function runAgent({
  agentName,
  userRef,
  input,
  session,
  policyOverride,
  attach,
  attachOpts,
  usageProbe,
  receiptsPerMessage,
  debug,
}: {
  agentName: string;
  userRef: string;
  input: string;
  session?: string;
  policyOverride?: string;
  attach?: string[];
  attachOpts?: AttachOpts;
  usageProbe?: boolean;
  receiptsPerMessage?: boolean;
  debug?: boolean;
}) {
  const agent = loadAgent(agentName);
  const policy = await loadPolicy(policyOverride || agent.policy);

  let sessionId = session;
  if (sessionId) {
    const s = getSession(sessionId);
    if (!s) throw new Error(`Unknown session ${sessionId}`);
  } else {
    sessionId = createSession(userRef, agentName, policy.policy);
  }

  // RPM check
  assertWithinRpm(userRef, policy.tenancy.per_user_rpm);

  // Build message history
  const history = listMessages(sessionId!, 50);
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: agent.system },
    ...history.map((m) => ({ role: m.role as any, content: m.content })),
    { role: "user", content: input },
  ];
  let attachmentBlock: string | undefined;
  if (attach && attach.length) {
    attachmentBlock = await buildAttachmentMessage(attach, attachOpts ?? {});
    messages.push({ role: "user", content: attachmentBlock });
  }

  addMessage(sessionId!, "user", input);

  let captured = "";
  const handler = async (res: Response, onFirstChunk: () => void) => {
    captured = await streamSSEToBufferAndStdout(res, onFirstChunk);
  };

  const start = Date.now();
  const { routeFinal, fallbackCount, latency, firstTokenMs, reasons, usagePrompt, usageCompletion } = await runWithFallback(
    { primary: policy.routing.primary, backups: policy.routing.backups },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages,
    Math.min(policy.objectives.max_tokens ?? 1024, 2048),
    policy.strategy.fallback_on_latency_ms ?? 1500,
    policy.strategy.max_attempts,
    policy.strategy.backoff_ms,
    policy.strategy.first_chunk_gate_ms,
    policy.gen ?? undefined,
    policy.routing.params ?? undefined,
    handler,
    !!debug
  );

  addMessage(sessionId!, "assistant", captured);

  const usage = { prompt: usagePrompt ?? 300, completion: usageCompletion ?? 200 };
  // Optional usage probe for prompt tokens if missing
  if (usageProbe && usagePrompt == null) {
    const perModel = (policy.routing.params || {})[routeFinal] || {};
    const merged = { ...(policy.gen || {}), ...perModel } as any;
    const { probeUsageFromJSON } = await import("./util/usage.js");
    const probe = await probeUsageFromJSON({ model: routeFinal, messages, max_tokens: 1, ...(merged.temperature != null ? { temperature: merged.temperature } : {}), ...(merged.top_p != null ? { top_p: merged.top_p } : {}), ...(merged.stop ? { stop: merged.stop } : {}), ...(merged.json_mode ? { response_format: { type: "json_object" } } : {}) });
    if (probe?.prompt != null) usage.prompt = probe.prompt;
    if (usage.completion == null && probe?.completion != null) usage.completion = probe.completion;
  }
  const cost = estimateCost(routeFinal, usage.prompt, usage.completion);
  addDailyTokens(
    userRef,
    usage.prompt + usage.completion,
    policy.tenancy.per_user_daily_tokens,
    policy.tenancy.timezone
  );

  process.stderr.write(
    `\n[session ${sessionId}] route=${routeFinal} fallbacks=${fallbackCount} latency=${latency}ms\n`
  );

  // Optional per-message receipt for session turns
  if (receiptsPerMessage) {
    const includeSnapshot = process.env.ROUTEPILOT_SNAPSHOT_INPUT === '1';
    const last = db.prepare("SELECT id FROM receipts WHERE task_id=? ORDER BY ts DESC LIMIT 1").get(sessionId!) as { id: string } | undefined;
    const policyHash = sha256Hex(JSON.stringify(policy));
    const rid = writeReceipt({
      policy: policy.policy,
      route_primary: policy.routing.primary[0],
      route_final: routeFinal,
      fallback_count: fallbackCount,
      latency_ms: latency,
      first_token_ms: firstTokenMs ?? null,
      reasons,
      usage: { prompt: usage.prompt, completion: usage.completion, cost: estimateCost(routeFinal, usage.prompt, usage.completion) },
      task_id: sessionId!,
      parent_id: last?.id ?? null,
      prompt_hash: sha256Hex(input + (attachmentBlock ? `\n\n${attachmentBlock}` : "")),
      policy_hash: policyHash,
      extras: includeSnapshot ? { input_snapshot: input, attachments_snapshot: attachmentBlock, assistant_snapshot: captured } : undefined,
    });
    // Print receipt id for visibility
    process.stderr.write(` [receipt ${rid}]`);
  }

  // Record trace for p95 routing decisions (per model)
  db.prepare(
    `INSERT INTO traces(id, ts, user_ref, policy, route_primary, route_final, latency_ms, tokens, cost_usd)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    uuid(),
    new Date(start).toISOString(),
    userRef,
    policy.policy,
    policy.routing.primary[0],
    routeFinal,
    latency,
    usage.prompt + usage.completion,
    cost
  );

  return { sessionId };
}
