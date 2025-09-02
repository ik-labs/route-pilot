import fs from "node:fs";
import path from "node:path";
import * as yaml from "yaml";
import { AgentsFile, AgentSpecT } from "./types.js";

let cache: { byName: Map<string, AgentSpecT>; raw: AgentSpecT[] } | null = null;

export function loadAgentsFile(): { byName: Map<string, AgentSpecT>; raw: AgentSpecT[] } {
  if (cache) return cache;
  const file = path.join("agents", "agents.yaml");
  if (!fs.existsSync(file)) throw new Error(`agents/agents.yaml not found`);
  const raw = fs.readFileSync(file, "utf8");
  const parsed = AgentsFile.parse(yaml.parse(raw));
  const byName = new Map<string, AgentSpecT>();
  for (const a of parsed.agents) byName.set(a.name, a);
  cache = { byName, raw: parsed.agents };
  return cache;
}

export function getAgentSpec(name: string): AgentSpecT {
  const { byName } = loadAgentsFile();
  const a = byName.get(name);
  if (!a) throw new Error(`Unknown agent '${name}' in agents.yaml`);
  return a;
}

export function listAgentSpecs(): AgentSpecT[] {
  return loadAgentsFile().raw;
}

