#!/usr/bin/env tsx
import { safeLastJson } from "../src/util/json.js";
import { loadAgentsFile } from "../src/subagents/registry.js";

function assert(cond: any, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }

// Test JSON extraction
const streamish = "junk data data {\"a\":1,\"b\":{\"c\":2}} trailing tokens}";
const obj = safeLastJson(streamish);
assert(obj.a === 1 && obj.b.c === 2, "safeLastJson extracts last object");

// Test agents file loads
const { raw } = loadAgentsFile();
assert(Array.isArray(raw) && raw.length >= 1, "agents.yaml loaded");

console.log("sanity OK");

