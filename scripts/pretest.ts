#!/usr/bin/env tsx
// Quick preflight to ensure native deps (better-sqlite3) are built for this Node.
// If not, print a friendly hint and exit non-zero so `pnpm test` stops early.

async function main() {
  try {
    await import("../src/db.js");
    console.log("pretest OK (SQLite module loaded)");
  } catch (e: any) {
    const msg = String(e?.message || e || "");
    const stack = String(e?.stack || "");
    const isAbi = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better-sqlite3/.test(msg + stack);
    console.error("Pretest failed to load SQLite.\n");
    if (isAbi) {
      console.error("It looks like better-sqlite3 needs a rebuild for your Node runtime.\n");
      console.error("Try:\n  pnpm approve-builds\n  pnpm rebuild\n");
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
}

main();

