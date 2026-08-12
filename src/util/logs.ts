import { MAX_DIAGNOSTIC_BYTES } from '../constants.js';
import { stripVTControlCharacters } from 'node:util';

const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const INLINE_SECRET =
  /\b(token|key|secret|password|credential|authorization|auth)\s*[:=]\s*([^\r\n,;]+)/gi;
const KNOWN_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,})\b/g;

function replaceLiteral(input: string, value: string): string {
  if (value.length < 4) return input;
  return input.split(value).join('[REDACTED]');
}

function sanitizeControls(input: string): string {
  let output = '';
  for (const character of stripVTControlCharacters(input)) {
    const code = character.codePointAt(0) ?? 0;
    if ((code <= 0x1f && character !== '\n' && character !== '\r' && character !== '\t') || code === 0x7f) {
      output += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      output += character;
    }
  }
  return output;
}

export function secretValuesFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return Object.entries(environment)
    .filter(([name, value]) => SECRET_NAME.test(name) && Boolean(value))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
}

export function redactSecrets(
  input: string,
  secretValues: readonly string[] = secretValuesFromEnvironment(),
): string {
  let output = input;
  for (const value of secretValues) output = replaceLiteral(output, value);
  output = output.replace(KNOWN_TOKEN, '[REDACTED]');
  output = output.replace(INLINE_SECRET, '$1=[REDACTED]');
  return sanitizeControls(output);
}

export function truncateUtf8(input: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return '';
  const bytes = Buffer.from(input);
  if (bytes.byteLength <= maximumBytes) return input;
  const marker = Buffer.from('\n... output truncated ...\n');
  if (marker.byteLength >= maximumBytes) {
    return marker.subarray(0, maximumBytes).toString('utf8');
  }
  const available = Math.max(0, maximumBytes - marker.byteLength);
  let headLength = Math.floor(available / 2);
  const tailLength = available - headLength;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (headLength > 0) {
    try {
      decoder.decode(bytes.subarray(0, headLength));
      break;
    } catch {
      headLength -= 1;
    }
  }

  let tailStart = bytes.byteLength - tailLength;
  while (tailStart < bytes.byteLength && ((bytes[tailStart] ?? 0) & 0xc0) === 0x80) {
    tailStart += 1;
  }
  return Buffer.concat([
    bytes.subarray(0, headLength),
    marker,
    bytes.subarray(tailStart),
  ]).toString('utf8');
}

export function diagnosticExcerpt(input: string): string {
  return truncateUtf8(redactSecrets(input).trim(), MAX_DIAGNOSTIC_BYTES);
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}
