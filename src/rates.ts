import fs from "node:fs";
import * as yaml from "yaml";

// Dollars per 1K tokens (PLACEHOLDERS — override via config/rates.yaml)
const DEFAULT_RATES: Record<string, { input: number; output: number }> = {
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic/claude-3-haiku": { input: 0.25, output: 1.25 },
  "mistral/small": { input: 0.1, output: 0.3 },
};

function loadOverrides(): Record<string, { input: number; output: number }> {
  const file = "config/rates.yaml";
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  const obj = yaml.parse(raw);
  return obj ?? {};
}

export function getRates(): Record<string, { input: number; output: number }> {
  return { ...DEFAULT_RATES, ...loadOverrides() };
}

export function estimateCost(model: string, prompt: number, completion: number) {
  const rates = getRates();
  const r = rates[model] ?? { input: 0.2, output: 0.8 };
  return (prompt * r.input + completion * r.output) / 1000;
}
