import { z } from "zod";

export const JSONSchema = z.any(); // keep permissive for now; validate shapes in future

export const AgentSpec = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: JSONSchema.optional(),
  output_schema: JSONSchema.optional(),
  policy: z.string(),
  tools: z.array(z.string()).optional(),
});

export type AgentSpecT = z.infer<typeof AgentSpec>;

export const AgentsFile = z.object({ agents: z.array(AgentSpec) });

export type TaskEnvelope<I = any, O = any> = {
  envelopeVersion: "1";
  taskId: string;
  parentId?: string;
  agent: string;
  agentVersion?: string;
  policy: string;
  budget: { tokens: number; costUsd: number; timeMs: number };
  input: I;
  context?: Record<string, any>;
  constraints?: Record<string, any>;
};

