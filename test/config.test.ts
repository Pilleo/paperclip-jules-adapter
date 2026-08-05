import { describe, it, expect } from 'vitest';
import { validateConfig, validateSecrets, AdapterConfigSchema } from '../src/server/config';
import { julesConfigSchema } from '../src/server/config-schema';

describe('Config', () => {
  it('validateConfig throws if source is missing', () => {
    expect(() => validateConfig({ repository: 'a' })).toThrow();
  });

  it('validateSecrets throws if JULES_API_KEY is missing', () => {
     expect(() => validateSecrets({})).toThrow('Missing JULES_API_KEY secret');
  });

  it('validateSecrets extracts token successfully', () => {
      const res = validateSecrets({ JULES_API_KEY: 'test' });
      expect(res.JULES_API_KEY).toBe('test');
  });

  it('declarative defaults satisfy runtime validation (no drift)', () => {
    const defaults = Object.fromEntries(
        julesConfigSchema.fields
          .filter(field => field.default !== undefined)
          .map(field => [field.key, field.default])
    );
    const result = AdapterConfigSchema.safeParse({
        ...defaults,
        source: 'sources/github/org/repo',
        repository: 'org/repo'
    });
    expect(result.success).toBe(true);
  });
});
