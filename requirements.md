
# What RoutePilot is (CLI edition)

A small command-line proxy/orchestrator that:

* reads a **policy YAML** (SLOs + routing order + quotas),
* calls **Vercel AI Gateway** to reach models,
* **streams** output to your terminal,
* **fails over** on stall/error,
* enforces **per-user token quotas**, and
* writes **receipts** (who/what/why/cost/latency) locally.

You’ll add a web dashboard later if you want—but the CLI already shows the value live.

---

# Repo layout (terminal-only)

```
routepilot/
  .env
  package.json
  tsconfig.json
  policies/
    balanced-helpdesk.yaml
  src/
    cli.ts                 # entry (commander / yargs)
    infer.ts               # runs a single request with streaming + failover
    router.ts              # chooses route & supervises stream
    gateway.ts             # fetch wrapper for AI Gateway
    policy.ts              # YAML parse + Zod validate
    quotas.ts              # per-user counters (Redis or local sqlite/json)
    receipts.ts            # build/sign/store receipts
    store.ts               # sqlite (better-sqlite3) or lowdb json
    util/stream.ts         # generic stream reader (OpenAI-compatible)
  data/
    receipts/              # JSON receipts per trace
    traces.db              # sqlite (optional)
```

---

# Env

```
AI_GATEWAY_BASE_URL= https://gateway.ai.vercel.ai/api/openai   # example
AI_GATEWAY_API_KEY=  <your-key>
REDIS_URL=           <optional for quotas; else use sqlite/json>
TZ= Asia/Kolkata
```

Node 20+, pnpm/npm, TypeScript.

---

# Policy (example)

`policies/balanced-helpdesk.yaml`

```yaml
policy: balanced-helpdesk
objectives:
  p95_latency_ms: 1200
  max_cost_usd: 0.010
  max_tokens: 1200
routing:
  primary: ["openai/gpt-4o-mini"]
  backups: ["anthropic/claude-3-haiku", "mistral/small"]
strategy:
  stream: true
  retry_on: ["5xx","rate_limit"]
  fallback_on_latency_ms: 1500
tenancy:
  per_user_daily_tokens: 20000
  per_user_rpm: 30
quality:
  judge: null
```

---

# CLI commands (UX)

* `routepilot infer -p balanced-helpdesk -u alice --input "Summarize: <text>" --stream`
* `routepilot infer -p balanced-helpdesk -u alice --file prompt.txt --shadow "mistral/small"`
* `routepilot usage -u alice` → prints tokens used / remaining today
* `routepilot replay -p balanced-helpdesk --last 50 --alts "anthropic/claude-3-haiku,mistral/small"`
* `routepilot receipts --open <id>` → pretty-print one receipt

---

# Core flow

1. **Load policy** → validate.
2. **Quota check** (`alice` today & rpm). If exceeded → exit 429 with friendly message.
3. **Pick route**:

   * start with `primary`,
   * if recent p95 for primary > target, pre-pick fastest backup.
4. **Call AI Gateway** using OpenAI-compatible endpoint (`/chat/completions`) **with `stream: true`**.
5. **Supervise stream**:

   * if **no first chunk** by `fallback_on_latency_ms` or a **5xx** → cancel and retry with next route.
   * stream chunks to terminal as they arrive.
6. On finish: compute **latency, tokens, route path**, estimate **cost** (based on provider rate map you maintain).
7. **Write receipt** to `data/receipts/<traceId>.json`, update quotas, print a 1-line summary.

---

# Minimal code (TypeScript)

**`src/gateway.ts`**

```ts
export type ChatParams = {
  model: string;
  messages: Array<{role:"system"|"user"|"assistant"; content:string}>;
  max_tokens?: number;
  stream?: boolean;
};

export function callGateway(params: ChatParams, signal?: AbortSignal) {
  const base = process.env.AI_GATEWAY_BASE_URL!;
  const key  = process.env.AI_GATEWAY_API_KEY!;
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(params),
    signal
  });
}
```

**`src/util/stream.ts`** (reads a streaming response to stdout)

```ts
export async function streamToStdout(res: Response, onFirstChunk: ()=>void) {
  if (!res.body) throw new Error("No body");
  const reader = res.body.getReader();
  let gotFirst = false;
  const dec = new TextDecoder();
  while (true) {
    const {value, done} = await reader.read();
    if (done) break;
    if (!gotFirst) { gotFirst = true; onFirstChunk(); }
    process.stdout.write(dec.decode(value));
  }
}
```

**`src/router.ts`** (fallback on stall/5xx)

```ts
import { callGateway } from "./gateway";
import { streamToStdout } from "./util/stream";

type RoutePlan = { primary: string[], backups: string[] };
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));

export async function runWithFallback(
  plan: RoutePlan,
  messages: any[],
  maxTokens: number,
  fallbackOnMs: number
) {
  const tries = [...plan.primary, ...plan.backups];
  let used: string[] = [];
  let start = Date.now();
  let routeFinal = "";
  let fallbackCount = 0;

  for (const model of tries) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), fallbackOnMs); // stall guard

    try {
      const res = await callGateway({ model, messages, max_tokens: maxTokens, stream: true }, ac.signal);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      let firstChunkSeen = false;
      const firstChunkTimer = setTimeout(() => {
        if (!firstChunkSeen) { ac.abort(); }
      }, fallbackOnMs);

      await streamToStdout(res, () => { firstChunkSeen = true; });

      clearTimeout(firstChunkTimer);
      clearTimeout(t);
      routeFinal = model;
      break; // success
    } catch (e) {
      fallbackCount++;
      used.push(model);
      // brief backoff before next try
      await sleep(100);
      continue;
    }
  }

  const latency = Date.now() - start;
  if (!routeFinal) throw new Error(`All routes failed after ${tries.length} attempts`);

  return { routeFinal, fallbackCount, latency };
}
```

**`src/receipts.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function writeReceipt(data: any) {
  const id = crypto.randomUUID();
  const file = path.join("data","receipts",`${id}.json`);
  const payload = {
    id,
    ts: new Date().toISOString(),
    ...data,
    signature: sign(data)
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return id;
}
function sign(obj:any) {
  const secret = process.env.JWT_SECRET ?? "dev-secret";
  const h = crypto.createHmac("sha256", secret);
  h.update(JSON.stringify(obj));
  return h.digest("hex");
}
```

**`src/infer.ts`**

```ts
import { runWithFallback } from "./router";
import { writeReceipt } from "./receipts";
import { loadPolicy } from "./policy";
import { checkAndIncQuota } from "./quotas";

export async function infer({policyName, userRef, input}:{policyName:string; userRef:string; input:string;}) {
  const policy = await loadPolicy(policyName);
  await checkAndIncQuota(userRef, 0, policy); // pre-check (tokens unknown yet)

  const messages = [{ role: "user", content: input }];
  const start = Date.now();
  const { routeFinal, fallbackCount, latency } =
    await runWithFallback(
      { primary: policy.routing.primary, backups: policy.routing.backups },
      messages,
      Math.min( policy.objectives.max_tokens ?? 1024, 2048 ),
      policy.strategy.fallback_on_latency_ms ?? 1500
    );

  // In a real build, parse streamed usage from Gateway headers/logs.
  const usage = { prompt: 300, completion: 200, cost: 0.0042 }; // demo estimate

  const rid = writeReceipt({
    policy: policy.policy,
    route_primary: policy.routing.primary[0],
    route_final: routeFinal,
    fallback_count: fallbackCount,
    latency_ms: latency,
    usage
  });

  await checkAndIncQuota(userRef, usage.prompt + usage.completion, policy);
  process.stderr.write(`\n\n[receipt ${rid}] route=${routeFinal} fallbacks=${fallbackCount} latency=${latency}ms cost=$${usage.cost}\n`);
}
```

**`src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { infer } from "./infer";

const program = new Command();
program.name("routepilot");

program.command("infer")
  .requiredOption("-p, --policy <name>")
  .requiredOption("-u, --user <userRef>")
  .option("--input <text>")
  .option("--file <path>")
  .action(async (opts) => {
    const text = opts.input ?? require("fs").readFileSync(opts.file, "utf8");
    await infer({ policyName: opts.policy, userRef: opts.user, input: text });
  });

program.parseAsync();
```

`package.json` (scripts)

```json
{
  "name": "routepilot",
  "type": "module",
  "bin": { "routepilot": "dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "yaml": "^2.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": { "tsx": "^4.15.7", "typescript": "^5.6.3" }
}
```

*(Add `policy.ts`, `quotas.ts`, `store.ts` trivially: parse YAML with `yaml`, validate with Zod; quotas: increment counters in sqlite/json; rpm gate via timestamp ring.)*

---

# Terminal demo script (90 seconds)

1. **Happy path**

   ```bash
   routepilot infer -p balanced-helpdesk -u alice --input "Summarize this email: We are moving the release to Friday."
   ```

   * Text streams instantly.
   * Tail line shows: `route=openai/gpt-4o-mini fallbacks=0 latency=680ms cost=$0.0039`.

2. **Simulated outage/stall**

   * Temporarily set `fallback_on_latency_ms: 300` in policy (or export `CHAOS_PRIMARY_STALL=1` and respect it in code).

   ```bash
   routepilot infer -p balanced-helpdesk -u alice --input "Draft a polite reply confirming the change."
   ```

   * First attempt aborts at 300ms → **fallback** to `claude-3-haiku` → still streams.
   * Tail line: `route=anthropic/claude-3-haiku fallbacks=1 latency=910ms cost=$0.0046`.

3. **Quota trip**

   ```bash
   for i in {1..40}; do routepilot infer -p balanced-helpdesk -u alice --input "One-liner about teamwork."; done
   ```

   * After N runs, CLI prints `429: daily token cap reached (resets at 00:00 IST)`.

4. **Receipts**

   ```bash
   cat data/receipts/<id>.json | jq .
   ```

   * Shows route path, timings, (estimated) tokens, cost, HMAC signature.

---

4. **Misc**

* `replay` command that takes last N receipts, re-runs prompts on alternate routes via Gateway, computes **cost/latency** deltas, and prints a **policy patch**.
* Basic `usage` command reading your quota store.
* Optional: `--judge` to score outputs when replaying (compare structures, length, or ask a small judge model).

