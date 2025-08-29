import fs from "node:fs";
import path from "node:path";
import * as yaml from "yaml";
import { z } from "zod";

const PolicySchema = z.object({
  policy: z.string(),
  objectives: z.object({
    p95_latency_ms: z.number().int().positive(),
    max_cost_usd: z.number().positive(),
    max_tokens: z.number().int().positive(),
  }),
  routing: z.object({
    primary: z.array(z.string()).min(1),
    backups: z.array(z.string()).default([]),
    p95_window_n: z.number().int().positive().default(50),
  }),
  strategy: z.object({
    stream: z.boolean().default(true),
    retry_on: z.array(z.string()).default([]),
    fallback_on_latency_ms: z.number().int().positive().default(1500),
    max_attempts: z.number().int().positive().default(3),
    backoff_ms: z.array(z.number().int().nonnegative()).default([100, 300]),
  }),
  tenancy: z.object({
    per_user_daily_tokens: z.number().int().positive().default(20000),
    per_user_rpm: z.number().int().positive().default(30),
    timezone: z.string().default("Asia/Kolkata"),
  }),
  gen: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      top_p: z.number().min(0).max(1).optional(),
      system: z.string().optional(),
      stop: z.array(z.string()).optional(),
      json_mode: z.boolean().optional(),
    })
    .optional(),
  quality: z.object({ judge: z.string().nullable().optional() }).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(name: string): Policy {
  const file = path.join("policies", `${name}.yaml`);
  const raw = fs.readFileSync(file, "utf8");
  const obj = yaml.parse(raw);
  return PolicySchema.parse(obj);
}
