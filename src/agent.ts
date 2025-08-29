import crypto from "node:crypto";
import db from "./db.js";
import { loadAgent } from "./agents.js";
import { loadPolicy } from "./policy.js";
import { addDailyTokens, assertWithinRpm } from "./quotas.js";
import { estimateCost } from "./rates.js";
import { runWithFallback } from "./router.js";
import { streamSSEToBufferAndStdout } from "./util/stream.js";
import { buildAttachmentMessage, AttachOpts } from "./util/files.js";

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
  debug,
}: {
  agentName: string;
  userRef: string;
  input: string;
  session?: string;
  policyOverride?: string;
  attach?: string[];
  attachOpts?: AttachOpts;
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
  if (attach && attach.length) {
    const attachmentBlock = await buildAttachmentMessage(attach, attachOpts ?? {});
    messages.push({ role: "user", content: attachmentBlock });
  }

  addMessage(sessionId!, "user", input);

  let captured = "";
  const handler = async (res: Response, onFirstChunk: () => void) => {
    captured = await streamSSEToBufferAndStdout(res, onFirstChunk);
  };

  const { routeFinal, fallbackCount, latency } = await runWithFallback(
    { primary: policy.routing.primary, backups: policy.routing.backups },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages,
    Math.min(policy.objectives.max_tokens ?? 1024, 2048),
    policy.strategy.fallback_on_latency_ms ?? 1500,
    policy.strategy.max_attempts,
    policy.strategy.backoff_ms,
    policy.gen ?? undefined,
    handler,
    !!debug
  );

  addMessage(sessionId!, "assistant", captured);

  const usage = { prompt: 300, completion: 200 };
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

  return { sessionId };
}
