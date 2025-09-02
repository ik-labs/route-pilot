#!/usr/bin/env tsx
import http from 'node:http';
import { runWithFallback } from '../src/router.js';

function sse(res: http.ServerResponse, chunks: string[], opts?: { delayFirstMs?: number; usage?: { prompt?: number; completion?: number }}) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  if (opts?.usage?.prompt != null) res.setHeader('x-usage-prompt-tokens', String(opts.usage.prompt));
  if (opts?.usage?.completion != null) res.setHeader('x-usage-completion-tokens', String(opts.usage.completion));
  const write = (data: string) => res.write(`data: ${data}\n\n`);
  const send = async () => {
    if (opts?.delayFirstMs) await new Promise(r => setTimeout(r, opts.delayFirstMs));
    for (const c of chunks) { write(JSON.stringify({ choices: [{ delta: { content: c } }] })); }
    write('[DONE]');
    res.end();
  };
  void send();
}

async function main() {
  const port = 33333;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const model = j.model || 'unknown';
          if (model === 'stub/primary-stall') {
            // Never produce first chunk within 200ms
            sse(res, ['A', 'B', 'C'], { delayFirstMs: 500, usage: { prompt: 10, completion: 5 } });
          } else if (model === 'stub/primary-5xx') {
            res.statusCode = 503;
            res.end('Service Unavailable');
          } else if (model === 'stub/slow') {
            sse(res, ['x'], { delayFirstMs: 800, usage: { prompt: 10, completion: 5 } });
          } else if (model === 'stub/fast') {
            sse(res, ['y'], { delayFirstMs: 10, usage: { prompt: 10, completion: 5 } });
          } else {
            sse(res, ['ok'], { delayFirstMs: 10, usage: { prompt: 10, completion: 5 } });
          }
        } catch {
          res.statusCode = 400; res.end('bad');
        }
      });
      return;
    }
    res.statusCode = 404; res.end('not found');
  });
  await new Promise<void>((resolve) => srv.listen(port, resolve));
  process.env.AI_GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.AI_GATEWAY_API_KEY = 'test';

  // Test stall fallback
  {
    const { routeFinal, fallbackCount, reasons } = await runWithFallback(
      { primary: ['stub/primary-stall'], backups: ['stub/backup'] },
      200,
      10,
      [{ role: 'user', content: 'hi' }],
      64,
      200,
      2,
      [0],
      0,
      0,
      {},
      undefined,
      undefined,
      false
    );
    if (routeFinal !== 'stub/backup' || fallbackCount < 1 || !reasons.includes('stall')) {
      console.error('stall fallback failed', { routeFinal, fallbackCount, reasons });
      process.exit(1);
    }
  }

  // Test 5xx fallback
  {
    const { routeFinal, fallbackCount, reasons } = await runWithFallback(
      { primary: ['stub/primary-5xx'], backups: ['stub/backup'] },
      200,
      10,
      [{ role: 'user', content: 'hi' }],
      64,
      500,
      2,
      [0],
      0,
      0,
      {},
      undefined,
      undefined,
      false
    );
    if (routeFinal !== 'stub/backup' || fallbackCount < 1 || !reasons.some(r => r === '5xx' || r.startsWith('http_'))) {
      console.error('5xx fallback failed', { routeFinal, fallbackCount, reasons });
      process.exit(1);
    }
  }

  // Test external abort via early-stop (simulate fan-out slow/fast)
  {
    const ac = new AbortController();
    const slow = runWithFallback(
      { primary: ['stub/slow'], backups: [] },
      1000, 10, [{ role: 'user', content: 'hi' }], 64, 1500, 1, [0], 0, 0, {}, undefined, ac.signal, false
    );
    const fast = runWithFallback(
      { primary: ['stub/fast'], backups: [] },
      1000, 10, [{ role: 'user', content: 'hi' }], 64, 1500, 1, [0], 0, 0, {}, undefined, undefined, false
    );
    const winner = await Promise.race([slow.then(() => 'slow'), fast.then(() => 'fast')]);
    if (winner !== 'fast') { console.error('early-stop race failed'); process.exit(1); }
    // Abort slow after fast finishes
    ac.abort();
    await Promise.allSettled([slow, fast]);
  }

  srv.close();
  console.log('integration OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
