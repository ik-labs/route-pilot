#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import fs from "node:fs";
import { createRequire } from "node:module";
import { infer } from "./infer.js";
import { usageSummary } from "./quotas.js";
import { getReceipt, listReceipts } from "./receipts.js";
import { runAgent } from "./agent.js";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const program = new Command();
program
  .name("routepilot")
  .description("Policy-driven AI gateway CLI with streaming, failover, quotas, and receipts")
  .version(pkg.version);

program
  .command("infer")
  .description("Run a single inference using a policy (streams output with failover)")
  .requiredOption("-p, --policy <name>")
  .requiredOption("-u, --user <userRef>")
  .option("--input <text>", "inline prompt text")
  .option("--file <path>", "read prompt from file path")
  .option("--json", "print one-line summary as JSON after stream", false)
  .option(
    "--mirror-json",
    "also mirror receipt JSON to data/receipts for inspection",
    false
  )
  .action(async (opts) => {
    if (!opts.input && !opts.file) {
      console.error("Provide --input <text> or --file <path>");
      process.exitCode = 1;
      return;
    }
    const text = opts.input ?? fs.readFileSync(opts.file, "utf8");
    await infer({
      policyName: opts.policy,
      userRef: opts.user,
      input: text,
      mirrorJson: !!opts["mirrorJson"],
      json: !!opts["json"],
    });
  });

program
  .command("usage")
  .description("Show per-user usage totals (today and month to date)")
  .requiredOption("-u, --user <userRef>")
  .option("--tz <zone>", "IANA timezone for windowing (defaults to env TZ or Asia/Kolkata)")
  .option("--json", "output JSON", false)
  .action((opts) => {
    const tz = opts.tz || process.env.TZ || "Asia/Kolkata";
    const u = usageSummary(opts.user, tz);
    if (opts.json) console.log(JSON.stringify(u));
    else console.log(`user=${opts.user} today=${u.tokensToday} month=${u.tokensMonth} (day=${u.day}, tz=${tz})`);
  });

program
  .command("receipts")
  .description("List recent receipts or open one by id")
  .option("--open <id>")
  .option("--limit <n>", "list last N", (v) => parseInt(v, 10), 10)
  .option("--json", "output JSON", false)
  .action((opts) => {
    if (opts.open) {
      const r = getReceipt(opts.open);
      if (!r) {
        console.error(`No receipt ${opts.open}`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) console.log(JSON.stringify(r));
      else console.log(r);
      return;
    }
    const rows = listReceipts(opts.limit);
    if (opts.json) console.log(JSON.stringify(rows));
    else rows.forEach((r: any) => console.log(`${r.id} ${r.ts} ${r.policy} -> ${r.route_final} ${r.latency_ms}ms $${r.cost_usd}`));
  });

program
  .command("replay")
  .description("Re-run prompts on alternate routes to compare (stub)")
  .action(() => {
    console.log("replay: not implemented (TODO)");
  });

program
  .command("agent")
  .description("Chat with an agent (multi-turn, session memory)")
  .requiredOption("-a, --agent <name>")
  .requiredOption("-u, --user <userRef>")
  .option("--session <id>", "existing session id to resume")
  .option("--policy <name>", "override policy name defined by agent")
  .option("--input <text>", "single-turn input; omit for interactive")
  .action(async (opts) => {
    if (opts.input) {
      const { sessionId } = await runAgent({
        agentName: opts.agent,
        userRef: opts.user,
        input: opts.input,
        session: opts.session,
        policyOverride: opts.policy,
      });
      console.error(`\n(session ${sessionId})`);
      return;
    }
    // interactive mode
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let sessionId = opts.session as string | undefined;
    console.log("Enter '/exit' to quit.\n");
    while (true) {
      const line = await rl.question("> ");
      if (!line || line.trim().toLowerCase() === "/exit") break;
      const res = await runAgent({
        agentName: opts.agent,
        userRef: opts.user,
        input: line,
        session: sessionId,
        policyOverride: opts.policy,
      });
      sessionId = res.sessionId;
      console.error(`\n(session ${sessionId})\n`);
    }
    rl.close();
  });

program.parseAsync();
