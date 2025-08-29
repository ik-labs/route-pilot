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
