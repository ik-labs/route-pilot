#!/usr/bin/env bash

# RoutePilot demo script
# Runs a curated sequence showing core features for recording.

set -euo pipefail

# Colors
Y="\x1b[33m"; G="\x1b[32m"; C="\x1b[36m"; R="\x1b[0m"; B="\x1b[1m"

title() {
  echo -e "\n${B}${C}==> $*${R}\n"
}

note() {
  echo -e "${Y}$*${R}"
}

# Preflight: ensure .env exists with required vars
if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and set your keys." >&2
  exit 1
fi

title "1) Basic infer (balanced-helpdesk)"
pnpm dev -- infer -p balanced-helpdesk -u demo --input "Hello from RoutePilot"

title "2) Demonstrate fallback on stall (CHAOS_PRIMARY_STALL)"
CHAOS_PRIMARY_STALL=1 pnpm dev -- infer -p balanced-helpdesk -u demo --input "Trigger a fallback demo"

title "3) Shadow route (no visible output, extra receipt)"
# Shadow an alternate configured model; using Anthropic here
pnpm dev -- infer -p balanced-helpdesk -u demo --input "Shadow check" --shadow anthropic/claude-3-haiku

title "4) Receipts: list last 5"
pnpm dev -- receipts --limit 5

title "5) Receipts: open the most recent (JSON)"
last_id=$(pnpm dev -- receipts --limit 1 --json | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
if [[ -n "${last_id}" ]]; then
  note "Opening receipt ${last_id}"
  pnpm dev -- receipts --open "${last_id}" --json
fi

title "6) Usage summary for user 'demo' (JSON)"
pnpm dev -- usage -u demo --json

title "7) Agents: create, list, plan"
pnpm dev -- agents:create --name helpdesk --policy balanced-helpdesk --system "You are a helpful, concise support agent." --force
pnpm dev -- agents
pnpm dev -- agents:plan --name helpdesk --text "Order 123 arrived damaged."

title "8) Agents: run a short session"
pnpm dev -- agents:run --name helpdesk --text "Order 123 arrived damaged. Please help." --usage-probe

title "9) Replay prompt on alternate models (no snapshots required)"
pnpm dev -- replay -p balanced-helpdesk --text "Write a one-liner about teamwork" --alts "anthropic/claude-3-haiku" --json

title "10) Mirror receipt JSON to data/receipts (one run)"
pnpm dev -- infer -p balanced-helpdesk -u demo --input "Mirror this receipt" --mirror-json --json
note "Check data/receipts/ for the mirrored JSON."

echo -e "\n${G}${B}Demo complete.${R}"
