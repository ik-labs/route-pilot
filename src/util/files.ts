import fs from "node:fs";
import path from "node:path";
// pdf-parse's top-level index.js executes test code when imported under some loaders.
// To avoid that, we import its internal lib entry directly at call time.
import { parse as parseCsvSync } from "csv-parse/sync";

export type AttachOpts = {
  maxChars?: number; // default 15000
  pdfPages?: string; // e.g., "1-5,8"
  csvMaxRows?: number; // default 50
  csvCols?: string; // e.g., "colA,colB"
};

const DEFAULT_MAX_CHARS = 15000;

function clampText(t: string, max = DEFAULT_MAX_CHARS) {
  if (t.length <= max) return t;
  return t.slice(0, max) + "\n...[truncated]";
}

function parsePageSpec(spec: string, total: number): number[] {
  const out: number[] = [];
  const ranges = spec.split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of ranges) {
    if (r.includes("-")) {
      const [a, b] = r.split("-").map((n) => parseInt(n, 10));
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(total, Math.max(a, b));
      for (let i = start; i <= end; i++) out.push(i);
    } else {
      const n = parseInt(r, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= total) out.push(n);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export async function loadPdf(file: string, pagesSpec?: string, maxChars?: number) {
  const buf = fs.readFileSync(file);
  const mod: any = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = (mod && mod.default) ? mod.default : mod;
  const parsed = await pdfParse(buf);
  let text = parsed.text || "";
  if (pagesSpec) {
    // naive page split based on form feed — pdf-parse includes \n\f between pages
    const pages = text.split("\f");
    const idxs = parsePageSpec(pagesSpec, pages.length);
    text = idxs.map((n) => pages[n - 1] ?? "").join("\n\n");
  }
  const name = path.basename(file);
  return `File: ${name} (pdf)\n\n` + clampText(text.trim(), maxChars ?? DEFAULT_MAX_CHARS);
}

export function loadCsv(file: string, maxRows = 50, csvCols?: string, maxChars?: number) {
  const raw = fs.readFileSync(file, "utf8");
  const records = parseCsvSync(raw, { columns: true });
  const cols = csvCols ? csvCols.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(records[0] ?? {});
  const sample = records.slice(0, maxRows).map((row: any) => {
    const picked: Record<string, any> = {};
    for (const c of cols) picked[c] = row[c];
    return picked;
  });
  const header = `File: ${path.basename(file)} (csv, cols=${cols.join(",")}, rows=${records.length}, sample=${sample.length})`;
  const body = "```csv\n" + [cols.join(","), ...sample.map((r: any) => cols.map((c) => r[c]).join(","))].join("\n") + "\n```";
  return clampText(header + "\n\n" + body, maxChars ?? DEFAULT_MAX_CHARS);
}

export function loadText(file: string, maxChars?: number) {
  const raw = fs.readFileSync(file, "utf8");
  const name = path.basename(file);
  return `File: ${name} (text)\n\n` + clampText(raw, maxChars ?? DEFAULT_MAX_CHARS);
}

export async function buildAttachmentMessage(paths: string[], opts: AttachOpts): Promise<string> {
  const parts: string[] = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    if (ext === ".pdf") {
      parts.push(await loadPdf(p, opts.pdfPages, opts.maxChars));
    } else if (ext === ".csv") {
      parts.push(loadCsv(p, opts.csvMaxRows ?? 50, opts.csvCols, opts.maxChars));
    } else if (ext === ".txt" || ext === ".md") {
      parts.push(loadText(p, opts.maxChars));
    } else {
      const stat = fs.statSync(p);
      parts.push(`File: ${path.basename(p)} (unsupported type ${ext || "unknown"}, size=${stat.size} bytes)`);
    }
  }
  return parts.join("\n\n---\n\n");
}
