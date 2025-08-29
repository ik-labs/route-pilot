import fs from "node:fs";
import path from "node:path";
import * as yaml from "yaml";
import { z } from "zod";

const AgentSchema = z.object({
  agent: z.string(),
  policy: z.string(),
  system: z.string(),
});

export type AgentDef = z.infer<typeof AgentSchema>;

export function loadAgent(name: string): AgentDef {
  const file = path.join("agents", `${name}.yaml`);
  const raw = fs.readFileSync(file, "utf8");
  return AgentSchema.parse(yaml.parse(raw));
}

export function listAgents(): string[] {
  const dir = "agents";
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
}

