export async function streamToStdout(
  res: Response,
  onFirstChunk: () => void
) {
  if (!res.body) throw new Error("No body");
  const reader = res.body.getReader();
  let gotFirst = false;
  const dec = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!gotFirst) {
      gotFirst = true;
      onFirstChunk();
    }
    process.stdout.write(dec.decode(value));
  }
}

export async function streamToBufferAndStdout(
  res: Response,
  onFirstChunk: () => void
): Promise<string> {
  if (!res.body) throw new Error("No body");
  const reader = res.body.getReader();
  let gotFirst = false;
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!gotFirst) {
      gotFirst = true;
      onFirstChunk();
    }
    const chunk = dec.decode(value);
    buf += chunk;
    process.stdout.write(chunk);
  }
  return buf;
}

// OpenAI-compatible SSE parser: prints only delta content, strips metadata.
export async function streamSSEToStdout(
  res: Response,
  onFirstChunk: () => void
) {
  if (!res.body) throw new Error("No body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let gotFirst = false;
  let buffer = "";
  let doneFlag = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    // Process full events separated by double newlines
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = event.split(/\r?\n/);
      for (const line of lines) {
        const m = /^data:\s*(.*)$/.exec(line);
        if (!m) continue;
        const data = m[1];
        if (data === "[DONE]") {
          doneFlag = true;
          break;
        }
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? "";
          if (delta) {
            if (!gotFirst) { gotFirst = true; onFirstChunk(); }
            process.stdout.write(delta);
          }
        } catch {
          // Fallback: ignore malformed JSON
        }
      }
      if (doneFlag) break;
    }
    if (doneFlag) break;
  }
}

export async function streamSSEToBufferAndStdout(
  res: Response,
  onFirstChunk: () => void
): Promise<string> {
  if (!res.body) throw new Error("No body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let gotFirst = false;
  let buffer = "";
  let captured = "";
  let doneFlag = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = event.split(/\r?\n/);
      for (const line of lines) {
        const m = /^data:\s*(.*)$/.exec(line);
        if (!m) continue;
        const data = m[1];
        if (data === "[DONE]") { doneFlag = true; break; }
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content ?? obj?.choices?.[0]?.text ?? "";
          if (delta) {
            if (!gotFirst) { gotFirst = true; onFirstChunk(); }
            captured += delta;
            process.stdout.write(delta);
          }
        } catch {
          // ignore
        }
      }
      if (doneFlag) break;
    }
    if (doneFlag) break;
  }
  return captured;
}
