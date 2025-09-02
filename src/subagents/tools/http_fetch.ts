import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export type HttpFetchOpts = {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number; // default 1MB
  allowHosts?: string[]; // explicit allowlist; else use env HTTP_FETCH_ALLOWLIST as comma list
  allowContentTypes?: string[]; // default ["application/json","text/plain","text/*","application/xml","application/xhtml+xml"]
};

const DEFAULT_MAX_BYTES = 1_000_000; // 1MB
const DEFAULT_CT = [
  "application/json",
  "text/plain",
  "text/",
  "application/xml",
  "application/xhtml+xml",
];

function isPrivateIPv4(ip: string): boolean {
  const n = ip.split(".").map((x) => parseInt(x, 10));
  if (n.length !== 4 || n.some((x) => Number.isNaN(x))) return false;
  if (n[0] === 10) return true;
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
  if (n[0] === 192 && n[1] === 168) return true;
  if (n[0] === 127) return true;
  if (n[0] === 0) return true;
  return false;
}

function isLoopbackOrLinkLocalIPv6(ip: string): boolean {
  return ip === "::1" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd");
}

function allowedHost(host: string, allowlist: string[]): boolean {
  if (!allowlist.length) return false;
  const h = host.toLowerCase();
  return allowlist.some((a) => {
    const aa = a.toLowerCase();
    if (aa.startsWith("*.")) {
      const suffix = aa.slice(1); // ".example.com"
      return h.endsWith(suffix) && h.split(".").length >= aa.split(".").length;
    }
    return h === aa;
  });
}

export async function httpFetch(urlStr: string, opts: HttpFetchOpts = {}) {
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) URLs allowed");

  const allow = (opts.allowHosts && opts.allowHosts.length)
    ? opts.allowHosts
    : (process.env.HTTP_FETCH_ALLOWLIST || "").split(/\s*,\s*/).filter(Boolean);
  if (!allowedHost(u.hostname, allow)) throw new Error(`Host not in allowlist: ${u.hostname}`);

  // Resolve host and check IPs
  const addrs = await dns.lookup(u.hostname, { all: true });
  for (const a of addrs) {
    if ((a.family === 4 && isPrivateIPv4(a.address)) || (a.family === 6 && isLoopbackOrLinkLocalIPv6(a.address))) {
      throw new Error("Resolved to private or loopback address; blocked");
    }
  }

  const method = opts.method || "GET";
  if (!["GET", "HEAD"].includes(method)) throw new Error("Only GET and HEAD are permitted");

  const lib = u.protocol === "https:" ? https : http;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers = opts.headers || {};

  return new Promise<{ status: number; headers: Record<string, string>; body?: string }>((resolve, reject) => {
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + (u.search || ""),
        method,
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) h[k.toLowerCase()] = v.join(", "); else if (v != null) h[k.toLowerCase()] = String(v);
        }
        const ct = (h["content-type"] || "").toLowerCase();
        const allowedCT = (opts.allowContentTypes && opts.allowContentTypes.length) ? opts.allowContentTypes : DEFAULT_CT;
        const ctOk = allowedCT.some((p) => ct.startsWith(p));
        if (!ctOk) { res.resume(); resolve({ status, headers: h }); return; }
        if (method === "HEAD") { res.resume(); resolve({ status, headers: h }); return; }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) { req.destroy(new Error("Response exceeds maxBytes")); return; }
          chunks.push(chunk as Buffer);
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ status, headers: h, body });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

