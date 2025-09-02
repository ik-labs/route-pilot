# RoutePilot (CLI)

A small, policy-driven CLI proxy/orchestrator for LLMs via Vercel AI Gateway. It reads a policy YAML, streams model output with supervised failover, enforces per-user quotas, and writes signed receipts to SQLite.

- OpenAI-compatible streaming via your Vercel AI Gateway project.
- Failover on stall/5xx, with p95-aware route pre-pick.
- Per-user daily token caps and sliding RPM.
- Signed receipts + traces in SQLite (WAL), optional pretty JSON mirror.

## Requirements
- Node 20+
- pnpm (recommended)
- Native toolchain for `better-sqlite3` (macOS/Linux dev tools). If builds are blocked by pnpm, run `pnpm approve-builds`.

## Install

- Local dev (from this repo):
  - `pnpm install`
  - If build scripts were blocked: `pnpm approve-builds` → allow `better-sqlite3` (and `esbuild` for `tsx`); then `pnpm rebuild`.
  - Run: `pnpm dev -- infer -p balanced-helpdesk -u alice --input "Hello"`

- Global (link locally while developing):
  - `pnpm link -g`
  - Then use `routepilot ...` from anywhere.

- As a dependency in another project (monorepo or app):
  - Add this repo as a package (e.g., workspace or Git URL) and add a script:
    ```json
    { "scripts": { "routepilot": "routepilot" } }
    ```
  - Or call it via `pnpm exec routepilot ...` after adding as a dep.

## Configuration

Create a `.env` at the repo root or in your project:

- `AI_GATEWAY_BASE_URL` — OpenAI-compatible base from Vercel AI Gateway (e.g., `https://gateway.ai.vercel.ai/api/openai`). RoutePilot calls `${BASE}/v1/chat/completions`.
- `AI_GATEWAY_API_KEY` — your Gateway key.
- Optional:
  - `ROUTEPILOT_MIRROR_JSON=1` — also write pretty receipts to `data/receipts/<id>.json`.
  - `JWT_SECRET` — HMAC secret for signing receipt payloads (defaults to `dev-secret`).
  - `ROUTEPILOT_SNAPSHOT_INPUT=1` — include input snapshots in receipt payloads (enables replay from receipts).
  - `ROUTEPILOT_REDACT=1` — redact basic PII (emails/phones) in mirrored/snapshot fields.
  - `HTTP_FETCH_ALLOWLIST` — comma-separated allowlist for the `http_fetch` tool (e.g., `api.example.com,*.example.org`).
  - `HTTP_FETCH_URL_TEMPLATE` — optional URL template for Retriever-like agents (e.g., `https://jsonplaceholder.typicode.com/posts/{id}`).
  - `HTTP_FETCH_MAX` — max allowed HTTP fetches per sub-agent (default 3).

Policies live under `policies/`. Starters:

- `policies/beginner-minimal.yaml` — minimal routing + quotas.
- `policies/balanced-helpdesk.yaml` — balanced defaults.
- `policies/advanced-controls.yaml` — advanced: p95 window, backoff, generation controls, timezone.

Rates are placeholder defaults merged with `config/rates.yaml` if present. Example:

```yaml
openai/gpt-4o-mini:       { input: 0.15, output: 0.60 }
anthropic/claude-3-haiku: { input: 0.25, output: 1.25 }
mistral/small:            { input: 0.10, output: 0.30 }
```

## Database

- SQLite file at `data/routepilot.db` (created automatically), WAL mode enabled.
- Tables: `receipts`, `traces`, `quotas_daily`, `rpm_events`.
- Schema is created idempotently on startup via `src/db.ts`.

## Usage

- Infer (streaming + failover):
  ```bash
  routepilot infer -p balanced-helpdesk -u alice --input "Summarize: ..."
  # or
  routepilot infer -p balanced-helpdesk -u alice --file prompt.txt
  # shadow an alternate model concurrently (no visible output)
  routepilot infer -p balanced-helpdesk -u alice --input "Test" --shadow mistral/small
  # with attachments (pdf, csv, txt, md)
  routepilot infer -p balanced-helpdesk -u alice --input "Summarize the attachment" \
    --attach report.pdf data.csv --pdf-pages 1-5 --csv-max-rows 50 --csv-cols "colA,colB" --max-chars 15000
  # flags
  #   --json         print a single JSON summary line after the stream
  #   --mirror-json  also mirror receipt JSON to data/receipts/
  #   --shadow       run a shadow model concurrently (no output)
  ```

- Usage (per-user day + month totals):
  ```bash
  routepilot usage -u alice --json
  # or specify timezone explicitly for reporting
  routepilot usage -u alice --tz UTC --json
  ```

- Receipts (list/show):
  ```bash
  routepilot receipts --limit 10
  routepilot receipts --open <id> --json
  # Per-task timeline (for sub-agent chains)
  routepilot receipts --timeline <taskId>
  # With ASCII tree
  routepilot receipts --timeline <taskId> --tree
  # Only show hops that used tools (adds a [tools] marker)
  routepilot receipts --timeline <taskId> --tools
  # Group by task (recent tasks summary)
  routepilot receipts --tasks --limit 10
  # Group by task since a timestamp (ISO); add --json for automation
  routepilot receipts --tasks --since 2025-09-01T00:00:00Z --limit 20 --json
  ```

- Replay:
  ```bash
  # Ad-hoc text replay across models (with heuristic judge scoring)
  routepilot replay -p balanced-helpdesk --text "Write a one-liner about teamwork" --alts "anthropic/claude-3-haiku,mistral/small" --judge

  # Replay a specific receipt (requires snapshots)
  # First, record a receipt with an input snapshot
  ROUTEPILOT_SNAPSHOT_INPUT=1 routepilot infer -p balanced-helpdesk -u alice --input "Draft a note..."
  # Then replay
  routepilot replay --open <receiptId> --alts "anthropic/claude-3-haiku,mistral/small"

  # Replay the last N receipts with snapshots
  routepilot replay --last 5 --alts "anthropic/claude-3-haiku,mistral/small"
  ```

- Chaos toggles (for demos):
  ```bash
  # Simulate primary model stall (forces fallback)
  CHAOS_PRIMARY_STALL=1 routepilot infer -p balanced-helpdesk -u alice --input "Test"
  # Simulate a 5xx from primary
  CHAOS_HTTP_5XX=1 routepilot infer -p balanced-helpdesk -u alice --input "Test"
  ```

## Agents

Agents are named configurations that pair a policy with a system prompt and session memory.

- List agents:
  ```bash
  routepilot agents:list
  routepilot agents:list --json
  ```

- Create a new agent:
  ```bash
  routepilot agents:create --name research-bot --policy balanced-helpdesk \
    --system "You are ResearchBot. Answer with citations and be concise."
  # Add --force to overwrite if it already exists
  ```

- Single-turn chat:
  ```bash
  routepilot agent -a support-bot -u alice --input "I can't log in."
  ```

- Interactive session (memory persisted to SQLite):
  ```bash
  routepilot agent -a support-bot -u alice
  # Type messages, '/exit' to quit; session id prints after replies
  ```
  - Optional: write a receipt per message (taskId = session)
    ```bash
    routepilot agent -a support-bot -u alice --receipts-per-message
    # Add ROUTEPILOT_SNAPSHOT_INPUT=1 to include input/output snapshots in receipt payloads
    ```

- Single-turn with attachments (pdf, csv, txt, md):
  ```bash
  routepilot agent -a support-bot -u alice --input "Analyze these files" \
    --attach report.pdf data.csv --pdf-pages 1-3 --csv-max-rows 30
  ```

- Resume a session:
  ```bash
  routepilot agent -a support-bot -u alice --session <sessionId> --input "Continue"
  ```

Agents are defined as YAML files under `agents/`:

```yaml
agent: support-bot
policy: balanced-helpdesk
system: |
  You are SupportBot, a concise, friendly support assistant.
```

The policy controls routing, retries, backoff, and generation knobs (`gen`), which apply to agent calls as well.

## Sub-agents (chains)

RoutePilot can orchestrate small sub-agents (skills) per policy and budget. A sample helpdesk chain is included using `agents/agents.yaml`.

- Plan a chain:
  ```bash
  routepilot agents:plan --name helpdesk --text "Order 123 arrived damaged."
  # Add --json for a machine-readable plan
  ```

- Run a chain (streams each hop; writes per-hop receipts):
  ```bash
  routepilot agents:run --name helpdesk --text "Order 123 arrived damaged."
  # Dry-run (validate schemas, no model calls)
  routepilot agents:run --name helpdesk --text "Order 123 arrived damaged." --dry-run
  # Add --json to print a final JSON summary
  ```

- Parallel variant (fan-out + reduce):
  ```bash
  routepilot agents:plan --name helpdesk-par --text "Order 123 arrived damaged." --json
  routepilot agents:run  --name helpdesk-par --text "Order 123 arrived damaged."
  ```

- HTTP fetch variant (demo):
  ```bash
  # Allow the demo host and set a URL template substituting {id}
  export HTTP_FETCH_ALLOWLIST=jsonplaceholder.typicode.com
  export HTTP_FETCH_URL_TEMPLATE=https://jsonplaceholder.typicode.com/posts/{id}
  routepilot agents:plan --name helpdesk-http --text "Order 1 and 2 arrived damaged."
  routepilot agents:run  --name helpdesk-http --text "Order 1 and 2 arrived damaged."
  ```

- AggregatorAgent behavior:
  - Deterministic merge of branch outputs into `records`.
  - Dedupe by `id` when present; prefer most complete object; shallow merge.
  - Stable sort: by `id` ascending or JSON-string order.
  - Strict JSON output: `{ "records": [...] }` (no fences).
  - Light output validation: schema mismatch warnings print to stderr (non-fatal).

- Parallel fan-out (library helpers for future chains):
  - `runFanOut(taskId, parentReceiptId, branches[])` — runs branches in parallel; each child gets `parent_id = parentReceiptId`.
  - `reduceFanOut(taskId, parentReceiptId, aggregatorAgent, branches, budget, context)` — runs a reducer with `parent_id = parentReceiptId` and includes `children_receipts` in receipt payload meta.
  - Timeline `--tree` will show branches under the parent node; reducer appears as a sibling under the same parent.

- Replay retriever steps (per-chain):
  ```bash
  # Human summary
  routepilot agents:replay --name helpdesk --text "Order 123 arrived damaged." --alts "anthropic/claude-3-haiku,mistral/small"
  # JSON output for tooling
  routepilot agents:replay --name helpdesk --text "Order 123 arrived damaged." --alts "anthropic/claude-3-haiku" --json
  ```

- Inspect receipts (now include first_token_ms, fallback reasons, and prompt_hash):
  ```bash
  routepilot receipts --limit 5 --json
  ```

Tip: `strategy.first_chunk_gate_ms` buffers initial output to avoid half-printed text during fallbacks. Fallback reasons include `stall`, `5xx`, `rate_limit`, etc.

HTTP tool (optional):
- When an agent declares `tools: [http_fetch]`, the controller can fetch small, allowlisted HTTP resources before the LLM call and pass results under `tool_results.http_fetch`.
- Configure env:
  - `HTTP_FETCH_ALLOWLIST=api.example.com,*.example.org`
  - `HTTP_FETCH_URL_TEMPLATE=https://jsonplaceholder.typicode.com/posts/{id}`
- In the helpdesk RetrieverAgent, if the input includes `ids: ["123", ...]`, it will GET the template per id (first 3 ids), parse JSON when content-type is JSON, and include a truncated body otherwise.
- These results appear inside the sub-agent input JSON (and in the receipt snapshot when `ROUTEPILOT_SNAPSHOT_INPUT=1`).

Validation:
- Inputs to each sub-agent are validated against their `input_schema` (light JSON Schema subset). If invalid, the run fails fast with a clear error.
- Outputs are validated against `output_schema` and warnings are printed to stderr on mismatch (non-fatal).

## How It Routes

- Starts with the `primary` in your policy.
- If recent p95 latency for the primary (from `traces`, window `routing.p95_window_n`) exceeds the policy target, it pre-picks the fastest backup (by recent p95) to try first.
- Supervises streaming:
  - Aborts if no first chunk within `fallback_on_latency_ms` or on 5xx; falls back to the next route.

## Quotas & Limits

- RPM: strict sliding 60s per user across all models (table `rpm_events`).
- Daily tokens: increments `quotas_daily` per user/day using `tenancy.timezone` (defaults to Asia/Kolkata).

## Policy Reference (current fields)

- `objectives.p95_latency_ms` — target latency; used for pre-pick logic.
- `objectives.max_cost_usd` — budget hint (not enforced yet per request level).
- `objectives.max_tokens` — upper bound for completion tokens.
- `routing.primary` / `routing.backups` — model order; `routing.p95_window_n` — recent sample size for p95.
  - `routing.params` — per-route overrides: `{ "model/name": { temperature, top_p, stop, json_mode } }`.
    Example:
    ```yaml
    routing:
      primary: ["openai/gpt-4o-mini"]
      backups: ["anthropic/claude-3-haiku", "mistral/small"]
      p95_window_n: 100
      params:
        "openai/gpt-4o-mini": { temperature: 0.2 }
        "anthropic/claude-3-haiku": { temperature: 0.1, top_p: 0.95 }
        "mistral/small": { temperature: 0.3, stop: ["\n\nUser:"] }
    ```
- `strategy.stream` — stream responses; `strategy.retry_on` — informational; `strategy.fallback_on_latency_ms` — stall cutoff; `strategy.max_attempts` — cap attempts; `strategy.backoff_ms` — per-attempt backoff; `strategy.first_chunk_gate_ms` — buffer initial stream to allow clean fallbacks.
- `gen` — optional: `system`, `temperature`, `top_p`, `stop`, `json_mode` (maps to OpenAI `response_format: {type: "json_object"}` when true).
- `tenancy.per_user_daily_tokens`, `tenancy.per_user_rpm`, `tenancy.timezone` — quotas + clock.
- Token accounting is placeholder for streaming; cost is estimated via rates. You can refine usage with a follow-up non-stream call if needed.

## Integration Patterns

- Global tool for local workflows: `pnpm link -g` and run `routepilot` in any repo.
- Project-local tool: add as a dependency and run via `pnpm exec routepilot` or a script.
- Programmatic (optional): You can import modules from `src/` (e.g., `infer`) within a TypeScript project if this repo is part of your workspace. The public API is primarily the CLI.

## Deployment Options

- Publish to npm (recommended for teams):
  - Ensure your `package.json` has proper name/version.
  - `pnpm publish --access public` (org policy dependent).
  - Consumers install: `pnpm add -D routepilot` or `pnpm add -g routepilot`.

- Containerize for CI runners:
  - Use Node 20 base, install deps (including native build for `better-sqlite3`).
  - Mount or persist `data/` if you need receipts/usage across runs.

- CI usage:
  - Set `AI_GATEWAY_BASE_URL` and `AI_GATEWAY_API_KEY` as secrets.
  - Call the CLI in steps (e.g., run benchmarks or replays later).

## Troubleshooting

- "Ignored build scripts" after `pnpm install`:
  - Run `pnpm approve-builds` → allow `better-sqlite3` (and `esbuild`), then `pnpm rebuild`.
- Missing env error:
  - Ensure `.env` contains `AI_GATEWAY_BASE_URL` and `AI_GATEWAY_API_KEY`.
- No streaming output:
  - Verify the Vercel AI Gateway project is configured and the endpoint supports `/v1/chat/completions` with streaming.
- Receipts/cost look off:
  - The MVP estimates usage for streaming; refine later with provider usage data or a follow-up non-stream call.

## Dev sanity checks

- Minimal sanity tests:
  ```bash
  pnpm tsx scripts/sanity.ts
  ```

- Quick test suite with preflight (rebuild hint if needed):
  ```bash
  pnpm test
  pnpm test:integration   # runs a local SSE stub to test fallbacks
  # If you see a pretest error about better-sqlite3/ABI, run:
  pnpm approve-builds
  pnpm rebuild
  ```

## Validation Guide

Follow this quick checklist to exercise core features end-to-end.

- Env setup:
  ```bash
  cp -n .env.example .env || true   # if you keep one
  # Ensure these are set in your .env
  # AI_GATEWAY_BASE_URL= https://gateway.ai.vercel.ai/api/openai
  # AI_GATEWAY_API_KEY=  <your-key>
  ```

- Basic infer + receipts:
  ```bash
  routepilot infer -p balanced-helpdesk -u alice --input "Hello world"
  routepilot receipts --limit 1
  ```

- Chaos fallback (stall and 5xx):
  ```bash
  CHAOS_PRIMARY_STALL=1 routepilot infer -p balanced-helpdesk -u alice --input "Test stall"
  CHAOS_HTTP_5XX=1     routepilot infer -p balanced-helpdesk -u alice --input "Test 5xx"
  ```

- Shadow route (no visible output; extra receipt):
  ```bash
  routepilot infer -p balanced-helpdesk -u alice --input "Shadow check" --shadow mistral/small
  ```

- Replay with judge scoring:
  ```bash
  routepilot replay -p balanced-helpdesk --text "One-liner about teamwork" --alts "anthropic/claude-3-haiku,mistral/small" --judge
  ```

- Agents (plan, run, dry-run):
  ```bash
  routepilot agents:plan --name helpdesk --text "Order 123 arrived damaged."
  routepilot agents:run  --name helpdesk --text "Order 123 arrived damaged."
  routepilot agents:run  --name helpdesk --text "Order 123 arrived damaged." --dry-run
  ```

- Tests & DB reset:
  ```bash
  pnpm test
  pnpm test:integration
  pnpm db:reset   # clears data/routepilot.db and mirrored receipts
  ```

## License

Add your preferred license file if distributing. By default, this repo has no explicit license.
