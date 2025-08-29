import { ConfigError } from "./util/errors.js";

export type ChatParams = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  response_format?: { type: string };
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new ConfigError(
      `Missing env ${name}. Add it to your .env`,
      name === "AI_GATEWAY_BASE_URL"
        ? "Get the OpenAI-compatible base from Vercel AI Gateway (usually ends with /api/openai)."
        : name === "AI_GATEWAY_API_KEY"
        ? "Create a Gateway key in your Vercel project and paste it here."
        : undefined
    );
  }
  return v;
}

export function callGateway(params: ChatParams, signal?: AbortSignal) {
  const base = requireEnv("AI_GATEWAY_BASE_URL"); // e.g., .../api/openai
  const url = `${base}/v1/chat/completions`;
  const key = requireEnv("AI_GATEWAY_API_KEY");
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    signal,
  });
}
