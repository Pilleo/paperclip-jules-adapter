import { describe, it, expect } from 'vitest';
import { validateConfig, validateSecrets } from '../src/server/config';

describe('Config', () => {
  it('validateConfig throws if source is missing', () => {
    expect(() => validateConfig({ repository: 'a' })).toThrow();
  });

  it('validateSecrets throws if JULES_API_KEY is missing', () => {
     expect(() => validateSecrets(undefined)).toThrow('Missing JULES_API_KEY');
  });

  it('validateSecrets extracts token successfully', () => {
      const res = validateSecrets('test');
      expect(res.JULES_API_KEY).toBe('test');
  });
});
