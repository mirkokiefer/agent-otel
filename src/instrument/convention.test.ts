import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  readConventionMode,
  resolveConventionMode,
  emitOpenInference,
  emitGenAI,
} from './convention.js';

const ENV_KEY = 'OTEL_SEMCONV_STABILITY_OPT_IN';

describe('convention.readConventionMode', () => {
  const originalEnv = process.env[ENV_KEY];
  beforeEach(() => { delete process.env[ENV_KEY]; });
  afterEach(()  => { if (originalEnv !== undefined) process.env[ENV_KEY] = originalEnv; else delete process.env[ENV_KEY]; });

  test('defaults to dup when env var unset', () => {
    expect(readConventionMode()).toBe('dup');
  });

  test('reads gen_ai_latest_experimental as gen_ai', () => {
    process.env[ENV_KEY] = 'gen_ai_latest_experimental';
    expect(readConventionMode()).toBe('gen_ai');
  });

  test('reads gen_ai_dup as dup', () => {
    process.env[ENV_KEY] = 'gen_ai_dup';
    expect(readConventionMode()).toBe('dup');
  });

  test('reads openinference as openinference', () => {
    process.env[ENV_KEY] = 'openinference';
    expect(readConventionMode()).toBe('openinference');
  });

  test('parses comma-separated values (http,gen_ai)', () => {
    process.env[ENV_KEY] = 'http,gen_ai_latest_experimental';
    expect(readConventionMode()).toBe('gen_ai');
  });

  test('ignores unrelated semconv tokens', () => {
    process.env[ENV_KEY] = 'http,database';
    expect(readConventionMode()).toBe('dup'); // unrelated → still default
  });

  test('gen_ai_latest_experimental wins over gen_ai_dup if both present', () => {
    process.env[ENV_KEY] = 'gen_ai_dup,gen_ai_latest_experimental';
    expect(readConventionMode()).toBe('gen_ai');
  });
});

describe('convention.resolveConventionMode', () => {
  test('programmatic option wins over env var', () => {
    process.env[ENV_KEY] = 'openinference';
    expect(resolveConventionMode({ conventionMode: 'gen_ai' })).toBe('gen_ai');
    delete process.env[ENV_KEY];
  });

  test('falls back to env var when no option', () => {
    process.env[ENV_KEY] = 'gen_ai_latest_experimental';
    expect(resolveConventionMode()).toBe('gen_ai');
    delete process.env[ENV_KEY];
  });
});

describe('convention.emit* predicates', () => {
  test('openinference mode → only OI', () => {
    expect(emitOpenInference('openinference')).toBe(true);
    expect(emitGenAI('openinference')).toBe(false);
  });

  test('gen_ai mode → only GenAI', () => {
    expect(emitOpenInference('gen_ai')).toBe(false);
    expect(emitGenAI('gen_ai')).toBe(true);
  });

  test('dup mode → both', () => {
    expect(emitOpenInference('dup')).toBe(true);
    expect(emitGenAI('dup')).toBe(true);
  });
});
