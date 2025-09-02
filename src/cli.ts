#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import fs from "node:fs";
import { createRequire } from "node:module";
import { infer } from "./infer.js";
import { usageSummary } from "./quotas.js";
import { getReceipt, listReceipts, timelineForTask, listTasks } from "./receipts.js";
import { runAgent } from "./agent.js";
import { listAgents, createAgent } from "./agents.js";
import { planChain, runChain } from "./subagents/run.js";
import { printFriendlyError } from "./util/errors.js";
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
  .option("--attach <paths...>", "attach one or more files (pdf, csv, txt, md)")
  .option("--max-chars <n>", "max attachment chars (default 15000)", (v) => parseInt(v, 10))
  .option("--pdf-pages <spec>", "pdf page ranges, e.g. 1-5,8")
  .option("--csv-max-rows <n>", "csv sample rows (default 50)", (v) => parseInt(v, 10))
  .option("--csv-cols <list>", "csv columns to include, e.g. a,b,c")
  .option("--json", "print one-line summary as JSON after stream", false)
  .option(
    "--mirror-json",
    "also mirror receipt JSON to data/receipts for inspection",
    false
  )
  .option("--debug", "verbose routing/debug logs", false)
  .action(async (opts) => {
    if (!opts.input && !opts.file) {
      console.error("Provide --input <text> or --file <path>");
      process.exitCode = 1;
      return;
    }
    try {
      const text = opts.input ?? fs.readFileSync(opts.file, "utf8");
      await infer({
        policyName: opts.policy,
        userRef: opts.user,
        input: text,
        attach: opts.attach,
        attachOpts: {
          maxChars: opts.maxChars,
          pdfPages: opts.pdfPages,
          csvMaxRows: opts.csvMaxRows,
          csvCols: opts.csvCols,
        },
        mirrorJson: !!opts["mirrorJson"],
        json: !!opts["json"],
        debug: !!opts["debug"],
      });
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("usage")
  .description("Show per-user usage totals (today and month to date)")
  .requiredOption("-u, --user <userRef>")
  .option("--tz <zone>", "IANA timezone for windowing (defaults to env TZ or Asia/Kolkata)")
  .option("--json", "output JSON", false)
  .action((opts) => {
    try {
      const tz = opts.tz || process.env.TZ || "Asia/Kolkata";
      const u = usageSummary(opts.user, tz);
      if (opts.json) console.log(JSON.stringify(u));
      else console.log(`user=${opts.user} today=${u.tokensToday} month=${u.tokensMonth} (day=${u.day}, tz=${tz})`);
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("receipts")
  .description("List recent receipts or open one by id")
  .option("--open <id>")
  .option("--limit <n>", "list last N", (v) => parseInt(v, 10), 10)
  .option("--timeline <taskId>", "show per-hop timeline for a taskId")
  .option("--tree", "render timeline as an ASCII tree", false)
  .option("--tasks", "list recent tasks (grouped by taskId)", false)
  .option("--json", "output JSON", false)
  .action((opts) => {
    try {
      if (opts.tasks) {
        const rows = listTasks(opts.limit);
        if (opts.json) { console.log(JSON.stringify(rows)); return; }
        if (!rows.length) { console.log("No tasks found."); return; }
        rows.forEach((r: any) => {
          console.log(`${r.taskId} hops=${r.hops} window=[${r.started} → ${r.finished}] cost=$${r.cost_usd}`);
        });
        return;
      }
      if (opts.timeline) {
        if (opts.tree) {
          const { timelineRowsRaw } = require("./receipts.js");
          const rows = timelineRowsRaw(opts.timeline);
          if (opts.json) { console.log(JSON.stringify(rows)); return; }
          if (!rows.length) { console.log(`No receipts found for taskId ${opts.timeline}`); return; }
          // Build adjacency by parent_id
          const byParent: Record<string, any[]> = {};
          const rootKey = `ROOT:${opts.timeline}`;
          for (const r of rows) {
            const key = r.parent_id || rootKey;
            byParent[key] = byParent[key] || [];
            byParent[key].push(r);
          }
          const printNode = (r: any, prefix: string, isLast: boolean) => {
            const branch = isLast ? "└─" : "├─";
            const nextPrefix = prefix + (isLast ? "  " : "│ ");
            const route = r.route ?? "?";
            const lat = r.latency_ms != null ? `${r.latency_ms}ms` : "-";
            const first = r.first_token_ms != null ? `${r.first_token_ms}ms` : "-";
            const reasons = r.reasons && r.reasons.length ? ` [${r.reasons.join(",")}]` : "";
            console.log(`${prefix}${branch} ${r.agent ?? "(agent?)"} -> ${route}  latency=${lat} first=${first} fallbacks=${r.fallbacks}${reasons}`);
            const kids = byParent[r.id] || [];
            kids.forEach((k, idx) => printNode(k, nextPrefix, idx === kids.length - 1));
          };
          console.log(`Task ${opts.timeline}`);
          const roots = (byParent[rootKey] || []).concat((byParent[null] || []));
          roots.forEach((r: any, idx: number) => printNode(r, "", idx === roots.length - 1));
          return;
        } else {
          const rows = timelineForTask(opts.timeline);
          if (opts.json) {
            console.log(JSON.stringify(rows));
            return;
          }
          if (!rows.length) {
            console.log(`No receipts found for taskId ${opts.timeline}`);
            return;
          }
          rows.forEach((r: any, i: number) => {
            const head = `#${i + 1}`.padEnd(4);
            const agent = (r.agent ?? "").padEnd(14);
            const route = r.route ?? "?";
            const lat = `${r.latency_ms ?? "-"}ms`;
            const first = r.first_token_ms != null ? `${r.first_token_ms}ms` : "-";
            const fall = `${r.fallbacks}`;
            const reasons = r.reasons && r.reasons.length ? ` [reasons: ${r.reasons.join(",")}]` : "";
            console.log(`${head} ${agent} -> ${route}  latency=${lat} first=${first} fallbacks=${fall}${reasons}`);
          });
          return;
        }
      }
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
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("replay")
  .description("Run a prompt across alternate models and compare latency/cost")
  .requiredOption("-p, --policy <name>")
  .requiredOption("--text <input>")
  .option("--alts <models>", "comma-separated alt routes, e.g. 'anthropic/claude-3-haiku,mistral/small'")
  .option("--json", "output JSON", false)
  .action(async (opts) => {
    try {
      const alts = (opts.alts ? String(opts.alts).split(/\s*,\s*/) : []).filter(Boolean);
      const { replayPrompt } = await import("./replay.js");
      const out = await replayPrompt(opts.policy, opts.text, alts);
      if (opts.json) {
        console.log(JSON.stringify(out));
        return;
      }
      console.log(`Policy: ${out.policy}`);
      console.log(`Primary: ${out.primary}`);
      console.log("\nResults:");
      out.results.forEach((r: any) => {
        console.log(`- ${r.model}  latency=${r.latency_ms}ms  tokens=${r.prompt_tokens + r.completion_tokens}  cost=$${r.cost_usd}`);
      });
      console.log("\nSuggested patch (routing):");
      console.log(`primary: [\"${out.primary}\"]`);
      console.log(`backups: [${out.suggestedPatch.routing.backups.map((m: string) => `\"${m}\"`).join(", ")}]`);
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("agents:plan")
  .description("Print the sub-agent execution plan")
  .requiredOption("--name <chain>", "chain name (e.g., helpdesk)")
  .option("--text <input>", "input text for helpdesk chain")
  .option("--json", "output JSON", false)
  .action(async (opts) => {
    try {
      const plan = await planChain(opts.name, { text: opts.text });
      if (opts.json) console.log(JSON.stringify(plan));
      else plan.forEach((s: any) => console.log(`#${s.step} ${s.agent} policy=${s.policy} budget=${JSON.stringify(s.budget)}${s.conditional ? ` (${s.conditional})` : ""}`));
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("agents:run")
  .description("Run a sub-agent chain (streams per step)")
  .requiredOption("--name <chain>", "chain name (e.g., helpdesk)")
  .requiredOption("--text <input>", "input text for the chain")
  .option("--json", "print a JSON summary at the end", false)
  .action(async (opts) => {
    try {
      const res = await runChain(opts.name, { text: opts.text });
      if (opts.json) console.log(JSON.stringify(res));
      else console.error(`\n[chain ${opts.name}] done task=${res.taskId}`);
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("agents:replay")
  .description("Replay a chain on alternate routes (stub)")
  .requiredOption("--name <chain>")
  .option("--text <input>")
  .option("--alts <models>", "comma-separated alt routes, e.g. 'anthropic/claude-3-haiku,mistral/small'")
  .action(async (opts) => {
    try {
      const alts = (opts.alts ? String(opts.alts).split(/\s*,\s*/) : []).filter(Boolean);
      console.log("agents:replay is not implemented yet. It would:");
      console.log(`- Run the '${opts.name}' plan${opts.text ? ` with input: ${opts.text}` : ''}`);
      console.log("- Re-execute each hop against alternate models:", alts.length ? alts.join(", ") : "(none provided)");
      console.log("- Compare latency/cost and produce a suggested policy patch.");
    } catch (e) {
      const code = printFriendlyError(e);
      process.exitCode = code;
    }
  });

program
  .command("agent")
  .description("Chat with an agent (multi-turn, session memory)")
  .requiredOption("-a, --agent <name>")
  .requiredOption("-u, --user <userRef>")
  .option("--session <id>", "existing session id to resume")
  .option("--policy <name>", "override policy name defined by agent")
  .option("--input <text>", "single-turn input; omit for interactive")
  .option("--attach <paths...>", "attach one or more files (pdf, csv, txt, md)")
  .option("--max-chars <n>", "max attachment chars (default 15000)", (v) => parseInt(v, 10))
  .option("--pdf-pages <spec>", "pdf page ranges, e.g. 1-5,8")
  .option("--csv-max-rows <n>", "csv sample rows (default 50)", (v) => parseInt(v, 10))
  .option("--csv-cols <list>", "csv columns to include, e.g. a,b,c")
  .option("--debug", "verbose routing/debug logs", false)
  .action(async (opts) => {
    if (opts.input) {
      try {
        const { sessionId } = await runAgent({
          agentName: opts.agent,
          userRef: opts.user,
          input: opts.input,
          session: opts.session,
          policyOverride: opts.policy,
          attach: opts.attach,
          attachOpts: {
            maxChars: opts.maxChars,
            pdfPages: opts.pdfPages,
            csvMaxRows: opts.csvMaxRows,
            csvCols: opts.csvCols,
          },
          debug: !!opts["debug"],
        });
        console.error(`\n(session ${sessionId})`);
        return;
      } catch (e) {
        const code = printFriendlyError(e);
        process.exitCode = code;
        return;
      }
    }
    // interactive mode
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let sessionId = opts.session as string | undefined;
    console.log("Enter '/exit' to quit.\n");
    while (true) {
      const line = await rl.question("> ");
      if (!line || line.trim().toLowerCase() === "/exit") break;
      try {
        const res = await runAgent({
          agentName: opts.agent,
          userRef: opts.user,
          input: line,
          session: sessionId,
          policyOverride: opts.policy,
          attach: opts.attach,
          attachOpts: {
            maxChars: opts.maxChars,
            pdfPages: opts.pdfPages,
            csvMaxRows: opts.csvMaxRows,
            csvCols: opts.csvCols,
          },
          debug: !!opts["debug"],
        });
        sessionId = res.sessionId;
        console.error(`\n(session ${sessionId})\n`);
      } catch (e) {
        const code = printFriendlyError(e);
        process.exitCode = code;
        break;
      }
    }
    rl.close();
  });

program
  .command("agents:list")
  .description("List available agents (from agents/*.yaml)")
  .option("--json", "output JSON", false)
  .action((opts) => {
    const agents = listAgents();
    if (opts.json) {
      console.log(JSON.stringify(agents));
      return;
    }
    if (!agents.length) {
      console.log("No agents found. Add YAML files under agents/.");
      return;
    }
    agents.forEach((a) => console.log(a));
  });

// Alias: `agents` behaves like `agents:list` for convenience
program
  .command("agents")
  .description("Alias for agents:list")
  .option("--json", "output JSON", false)
  .action((opts) => {
    const agents = listAgents();
    if (opts.json) {
      console.log(JSON.stringify(agents));
      return;
    }
    if (!agents.length) {
      console.log("No agents found. Add YAML files under agents/.");
      return;
    }
    agents.forEach((a) => console.log(a));
  });

program
  .command("agents:create")
  .description("Create a new agent YAML under agents/")
  .requiredOption("--name <agent>")
  .requiredOption("--policy <policy>")
  .option(
    "--system <text>",
    "system prompt",
    "You are an assistant. Be concise and helpful."
  )
  .option("--force", "overwrite if exists", false)
  .action((opts) => {
    try {
      const file = createAgent(opts.name, opts.policy, opts.system, {
        force: !!opts.force,
      });
      console.log(`Created ${file}`);
    } catch (e: any) {
      console.error(e.message || String(e));
      process.exitCode = 1;
    }
  });

// Workaround: when invoking via some runners (e.g., pnpm + tsx), a standalone "--" may
// be forwarded in argv and confuse subcommand parsing. Strip it before parsing.
const argv = process.argv.slice();
const dd = argv.indexOf("--");
if (dd !== -1) argv.splice(dd, 1);
program.parseAsync(argv);
