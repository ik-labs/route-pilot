import crypto from "node:crypto";

export function sha256Hex(text: string): string {
  const h = crypto.createHash("sha256");
  h.update(text, "utf8");
  return h.digest("hex");
}

