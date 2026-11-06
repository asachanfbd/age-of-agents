import type { FieldSpec } from '../buildings/contract.ts';

export type FieldsResult = { ok: true; value: Record<string, unknown> } | { ok: false; field: string; error: string };

class Refusal extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const characters = (text: string): number => [...text].length;

function checkValue(spec: FieldSpec, value: unknown, path: string): unknown {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new Refusal(path, `${path} must be text`);
      if (spec.required && !value.trim()) throw new Refusal(path, `${path} is required`);
      if (spec.max !== undefined && characters(value) > spec.max) throw new Refusal(path, `${path} must be at most ${spec.max} characters`);
      return value;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Refusal(path, `${path} must be a number`);
      if (spec.type === 'integer' && !Number.isSafeInteger(value)) throw new Refusal(path, `${path} must be a whole number`);
      if (spec.minValue !== undefined && value < spec.minValue) throw new Refusal(path, `${path} must be at least ${spec.minValue}`);
      if (spec.maxValue !== undefined && value > spec.maxValue) throw new Refusal(path, `${path} must be at most ${spec.maxValue}`);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') throw new Refusal(path, `${path} must be true or false`);
      return value;
    case 'enum':
      if (typeof value !== 'string' || !spec.values?.includes(value)) throw new Refusal(path, `${path} must be one of: ${(spec.values ?? []).join(', ')}`);
      return value;
    case 'array': {
      if (!Array.isArray(value)) throw new Refusal(path, `${path} must be a list`);
      if (spec.max !== undefined && value.length > spec.max) throw new Refusal(path, `${path} must have at most ${spec.max} items`);
      const item = spec.items;
      return item ? value.map((entry, index) => checkValue({ ...item, required: true }, entry, `${path}[${index}]`)) : value;
    }
    case 'object': {
      if (!isObject(value)) throw new Refusal(path, `${path} must be an object`);
      return checkObject(spec.fields ?? [], value, path);
    }
  }
}

function checkObject(specs: readonly FieldSpec[], input: Record<string, unknown>, prefix: string): Record<string, unknown> {
  const join = (name: string) => (prefix ? `${prefix}.${name}` : name);
  const known = new Set(specs.map((spec) => spec.name));
  for (const name of Object.keys(input)) if (!known.has(name)) throw new Refusal(join(name), `${join(name)} is not a field of this operation`);
  const out: Record<string, unknown> = {};
  for (const spec of specs) {
    const raw = input[spec.name];
    // null and an omitted field mean the same thing.
    if (raw === undefined || raw === null) {
      if (spec.required) throw new Refusal(join(spec.name), `${join(spec.name)} is required`);
      continue;
    }
    out[spec.name] = checkValue(spec, raw, join(spec.name));
  }
  return out;
}

/** Checks a value against declared fields. Unknown fields, wrong types and over-cap text are refused (never trimmed or truncated); the error names the field path. */
export function validateFields(specs: readonly FieldSpec[], input: unknown): FieldsResult {
  if (input === undefined || input === null) input = {};
  if (!isObject(input)) return { ok: false, field: 'inputs', error: 'inputs must be an object' };
  try {
    return { ok: true, value: checkObject(specs, input, '') };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, field: error.field, error: error.message };
    throw error;
  }
}
