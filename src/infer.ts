import { runWithFallback } from "./router";
import { writeReceipt } from "./receipts";
import { loadPolicy } from "./policy";
import { addDailyTokens, assertWithinRpm } from "./quotas";
import db from "./db";
import { estimateCost } from "./rates";

export async function infer({
  policyName,
  userRef,
  input,
  mirrorJson,
  json,
}: {
  policyName: string;
  userRef: string;
  input: string;
  mirrorJson?: boolean;
  json?: boolean;
}) {
  const policy = await loadPolicy(policyName);

  // RPM pre-check
  assertWithinRpm(userRef, policy.tenancy.per_user_rpm);

  const messages = [{ role: "user", content: input }];
  // Optional system prompt
  if (policy.gen?.system) {
    messages.unshift({ role: "system", content: policy.gen.system });
  }
  const start = Date.now();
  const { routeFinal, fallbackCount, latency } = await runWithFallback(
    { primary: policy.routing.primary, backups: policy.routing.backups },
    policy.objectives.p95_latency_ms,
    policy.routing.p95_window_n,
    messages,
    Math.min(policy.objectives.max_tokens ?? 1024, 2048),
    policy.strategy.fallback_on_latency_ms ?? 1500,
    policy.strategy.max_attempts,
    policy.strategy.backoff_ms,
    policy.gen
  );

  // Placeholder usage estimate (improve later using real usage)
  const usage = { prompt: 300, completion: 200 };
  const cost = estimateCost(routeFinal, usage.prompt, usage.completion);

  const rid = writeReceipt({
    policy: policy.policy,
    route_primary: policy.routing.primary[0],
    route_final: routeFinal,
    fallback_count: fallbackCount,
    latency_ms: latency,
    usage: { ...usage, cost },
    mirrorJson,
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
