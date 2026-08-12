function normalize(value: unknown, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Cannot serialize a circular value');
    seen.add(value);
    const record = value as Record<string, unknown>;
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) normalized[key] = normalize(item, seen);
    }
    seen.delete(value);
    return normalized;
  }

  throw new TypeError(`Unsupported JSON value: ${typeof value}`);
}

export function stableStringify(value: unknown, spacing = 2): string {
  return `${JSON.stringify(normalize(value, new Set()), null, spacing)}\n`;
}
