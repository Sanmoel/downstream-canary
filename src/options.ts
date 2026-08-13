import { CanaryError } from './errors.js';

export interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith('--')) {
      throw new CanaryError(
        'configuration',
        'configuration',
        `Unexpected positional argument ${JSON.stringify(argument)}.`,
      );
    }
    const equals = argument.indexOf('=');
    if (equals > 2) {
      const name = argument.slice(2, equals);
      const value = argument.slice(equals + 1);
      if (!name || !value || values.has(name) || flags.has(name)) {
        throw new CanaryError('configuration', 'configuration', `Invalid or duplicate option --${name}.`);
      }
      values.set(name, value);
      continue;
    }
    const name = argument.slice(2);
    if (name === 'help' || name === 'version' || name === 'local') {
      if (flags.has(name) || values.has(name)) {
        throw new CanaryError('configuration', 'configuration', `Duplicate option --${name}.`);
      }
      flags.add(name);
      continue;
    }
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) {
      throw new CanaryError('configuration', 'configuration', `Option --${name} requires a value.`);
    }
    if (values.has(name) || flags.has(name)) {
      throw new CanaryError('configuration', 'configuration', `Duplicate option --${name}.`);
    }
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

export function rejectUnknownOptions(
  parsed: ParsedArguments,
  allowedValues: ReadonlySet<string>,
): void {
  const unknown = [...parsed.values.keys()].filter((name) => !allowedValues.has(name));
  if (unknown.length > 0) {
    throw new CanaryError(
      'configuration',
      'configuration',
      `Unknown option(s): ${unknown.map((name) => `--${name}`).join(', ')}.`,
    );
  }
}
