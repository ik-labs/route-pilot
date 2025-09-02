#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

const dbPath = path.join('data', 'routepilot.db');
try {
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath);
    console.log(`Removed ${dbPath}`);
  } else {
    console.log(`No DB at ${dbPath}`);
  }
  const receiptsDir = path.join('data', 'receipts');
  if (fs.existsSync(receiptsDir)) {
    const files = fs.readdirSync(receiptsDir);
    for (const f of files) fs.rmSync(path.join(receiptsDir, f));
    console.log(`Cleared ${receiptsDir} (${files.length} files)`);
  }
} catch (e: any) {
  console.error(e?.message || String(e));
  process.exit(1);
}
console.log('db:reset done');

