import { describe, it, expect } from 'vitest';
import { validateConfig, validateSecrets } from '../src/server/config';

describe('Config', () => {
  it('validateConfig throws if source is missing', () => {
    expect(() => validateConfig({ repository: 'a' })).toThrow();
  });

  it('validateSecrets throws if JULES_API_KEY is missing', () => {
     expect(() => validateSecrets({})).toThrow('Missing JULES_API_KEY secret');
  });

  it('validateSecrets extracts paperclip api token', () => {
      const res = validateSecrets({ JULES_API_KEY: 'test', PAPERCLIP_API_TOKEN: 'token' });
      expect(res.PAPERCLIP_API_TOKEN).toBe('token');
  });
});
