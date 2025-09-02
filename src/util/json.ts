export function safeLastJson(text: string): any {
  let start = -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) { try { return JSON.parse(text.slice(start, i + 1)); } catch {} } }
  }
  try { return JSON.parse(text); } catch {}
  throw new Error("Failed to extract JSON from text");
}

