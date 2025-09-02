// Very light JSON Schema validator (subset):
// - Supports top-level type: object/array/string/number/boolean
// - Supports object.properties with simple `type`
// - Supports `required` list (presence only)
// This is meant for warnings only, not strict validation.

type JSONSchema = any;

function typeOf(v: any): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

export function validateAgainstSchema(schema: JSONSchema | undefined, value: any): { ok: boolean; errors: string[] } {
  if (!schema) return { ok: true, errors: [] };
  const errors: string[] = [];

  // Top-level type
  if (schema.type) {
    const t = schema.type;
    const vt = typeOf(value);
    if (t !== vt && !(Array.isArray(t) && (t as any[]).includes(vt))) {
      errors.push(`type mismatch: expected ${t}, got ${vt}`);
      // If top-level type mismatches, further checks will be noisy; return early
      return { ok: errors.length === 0, errors };
    }
  }

  // Object validation
  if ((schema.type === 'object' || (!schema.type && typeof value === 'object')) && value && !Array.isArray(value)) {
    const props = schema.properties || {};
    const required: string[] = schema.required || [];
    for (const key of required) {
      if (!(key in value)) errors.push(`missing required property: ${key}`);
    }
    for (const [key, ps] of Object.entries<any>(props)) {
      if (!(key in value)) continue;
      const vt = typeOf((value as any)[key]);
      if (ps && ps.type) {
        const pt = ps.type;
        if (pt !== vt && !(Array.isArray(pt) && (pt as any[]).includes(vt))) {
          errors.push(`property '${key}' type mismatch: expected ${pt}, got ${vt}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

