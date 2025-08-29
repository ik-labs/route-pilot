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

export function createAgent(
  name: string,
  policy: string,
  system: string,
  opts?: { force?: boolean }
) {
  const dir = "agents";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.yaml`);
  if (fs.existsSync(file) && !opts?.force) {
    throw new Error(`agents/${name}.yaml already exists (use --force to overwrite)`);
  }
  const doc = { agent: name, policy, system };
  fs.writeFileSync(file, yaml.stringify(doc));
  return file;
}
