import fs from "node:fs";
import path from "node:path";
import * as yaml from "yaml";
import { z } from "zod";
import { PolicyError } from "./util/errors.js";

const PolicySchema = z.object({
  policy: z.string(),
  policy_version: z.number().int().positive().optional(),
  notes: z.string().optional(),
  objectives: z.object({
    p95_latency_ms: z.number().int().positive(),
    max_cost_usd: z.number().positive(),
    max_tokens: z.number().int().positive(),
  }),
  routing: z.object({
    primary: z.array(z.string()).min(1),
    backups: z.array(z.string()).default([]),
    p95_window_n: z.number().int().positive().default(50),
    params: z
      .record(
        z.object({
          temperature: z.number().min(0).max(2).optional(),
          top_p: z.number().min(0).max(1).optional(),
          stop: z.array(z.string()).optional(),
          json_mode: z.boolean().optional(),
        })
      )
      .optional(),
  }),
  strategy: z.object({
    stream: z.boolean().default(true),
    retry_on: z.array(z.string()).default([]),
    fallback_on_latency_ms: z.number().int().positive().default(1500),
    max_attempts: z.number().int().positive().default(3),
    backoff_ms: z.array(z.number().int().nonnegative()).default([100, 300]),
    first_chunk_gate_ms: z.number().int().nonnegative().default(250),
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
    .nullish(),
  quality: z.object({ judge: z.string().nullable().optional() }).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export function loadPolicy(name: string): Policy {
  const file = path.join("policies", `${name}.yaml`);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = yaml.parse(raw);
    // Normalize aliases before validation (e.g., max_retries -> max_attempts)
    if (obj && obj.strategy) {
      if (obj.strategy.max_retries != null && obj.strategy.max_attempts == null) {
        obj.strategy.max_attempts = obj.strategy.max_retries;
      }
    }
    return PolicySchema.parse(obj);
  } catch (e: any) {
    if (e?.issues) {
      const details = e.issues.map((i: any) => `${i.path?.join(".") || "root"}: ${i.message}`);
      throw new PolicyError(`Invalid policy '${name}' (${file})`, details);
    }
    if (e?.code === "ENOENT") {
      throw new PolicyError(`Policy file not found: ${file}`);
    }
    throw new PolicyError(`Failed to load policy '${name}': ${e?.message || e}`);
  }
}
