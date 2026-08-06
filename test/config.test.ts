import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateConfig, requireJulesApiKey, AdapterConfigSchema } from '../src/server/config';
import { julesConfigSchema } from '../src/server/config-schema';

describe('Config', () => {
  it('validateConfig throws if source is missing', () => {
    expect(() => validateConfig({ repository: 'a' })).toThrow();
  });

  it('requireJulesApiKey throws if JULES_API_KEY is missing', () => {
     delete process.env['JULES_API_KEY'];
     expect(() => requireJulesApiKey()).toThrow('JULES_API_KEY is missing');
  });

  it('requireJulesApiKey extracts token successfully', () => {
      process.env['JULES_API_KEY'] = 'test';
      const res = requireJulesApiKey();
      expect(res).toBe('test');
      delete process.env['JULES_API_KEY'];
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
