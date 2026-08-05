import { describe, it, expect, vi } from 'vitest';
import { JulesClient } from '../src/server/jules-client';

describe('JulesClient Zod Validation', () => {
    it('getSession throws Zod error if name is missing', async () => {
       const client = new JulesClient('test');
       global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ state: 'RUNNING' })
       });

       await expect(client.getSession('id' as any)).rejects.toThrow(/Required/);
    });

    it('createSession sends correct shape based on Jules API schema', async () => {
       const client = new JulesClient('test');
       global.fetch = vi.fn().mockResolvedValueOnce({
          ok: true,
          json: async () => ({ name: 'sess-1' })
       });

       await client.createSession({
           prompt: 'test',
           title: 't',
           sourceContext: {
               source: 'sources/github',
               githubRepoContext: { startingBranch: 'main' }
           }
       });

       expect(global.fetch).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
              body: expect.stringContaining('"sourceContext":{"source":"sources/github","githubRepoContext":{"startingBranch":"main"}}')
          })
       );
    });
});
