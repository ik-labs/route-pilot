import { runWithFallback } from "./router.js";
import { writeReceipt } from "./receipts.js";
import { loadPolicy } from "./policy.js";
import { addDailyTokens, assertWithinRpm } from "./quotas.js";
import db from "./db.js";
import { estimateCost } from "./rates.js";
import { buildAttachmentMessage, AttachOpts } from "./util/files.js";
import { sha256Hex } from "./util/hash.js";

export async function infer({
  policyName,
  userRef,
  input,
  attach,
  attachOpts,
  mirrorJson,
  json,
  debug,
}: {
  policyName: string;
  userRef: string;
  input: string;
  attach?: string[];
  attachOpts?: AttachOpts;
  mirrorJson?: boolean;
  json?: boolean;
  debug?: boolean;
}) {
  const policy = await loadPolicy(policyName);

  // RPM pre-check
  assertWithinRpm(userRef, policy.tenancy.per_user_rpm);

  const messages = [{ role: "user", content: input }];
  let attachmentBlock: string | undefined;
  if (attach && attach.length) {
    attachmentBlock = await buildAttachmentMessage(attach, attachOpts ?? {});
    messages.push({ role: "user", content: attachmentBlock });
  }
  // Optional system prompt
  if (policy.gen?.system) {
    messages.unshift({ role: "system", content: policy.gen.system });
  }
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
    undefined,
    !!debug
  );

  // Real usage from headers when available; fallback to estimate
  const usage = {
    prompt: usagePrompt ?? 300,
    completion: usageCompletion ?? 200,
  };
  const cost = estimateCost(routeFinal, usage.prompt, usage.completion);

  const promptHash = sha256Hex(input + (attachmentBlock ? `\n\n${attachmentBlock}` : ""));
  const rid = writeReceipt({
    policy: policy.policy,
    route_primary: policy.routing.primary[0],
    route_final: routeFinal,
    fallback_count: fallbackCount,
    latency_ms: latency,
    first_token_ms: firstTokenMs ?? null,
    reasons,
    usage: { ...usage, cost },
    mirrorJson,
    prompt_hash: promptHash,
  });

  // Update quotas (daily tokens)
  addDailyTokens(
    userRef,
    usage.prompt + usage.completion,
    policy.tenancy.per_user_daily_tokens,
    policy.tenancy.timezone
  );

  // Track trace row for p95 decisions
  db.prepare(
    `INSERT INTO traces(id, ts, user_ref, policy, route_primary, route_final, latency_ms, tokens, cost_usd)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    rid,
    new Date(start).toISOString(),
    userRef,
    policy.policy,
    policy.routing.primary[0],
    routeFinal,
    latency,
    usage.prompt + usage.completion,
    cost
  );

  const summary = {
    receipt: rid,
    route: routeFinal,
    fallbacks: fallbackCount,
    latency_ms: latency,
    cost_usd: Number(cost.toFixed(6)),
  };

  if (json) {
    process.stderr.write("\n");
    console.log(JSON.stringify(summary));
  } else {
    process.stderr.write(
      `\n\n[receipt ${rid}] route=${routeFinal} fallbacks=${fallbackCount} latency=${latency}ms cost=$${summary.cost_usd}\n`
    );
  }
}
