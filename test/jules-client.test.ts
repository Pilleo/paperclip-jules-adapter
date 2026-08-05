import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JulesClient, JulesClientError, extractPullRequestUrl } from '../src/server/jules-client';
import { parseJulesSessionName, asJulesSessionId } from '../src/server/brands';

describe('JulesClient', () => {
  let client: JulesClient;
  const apiKey = 'test-api-key';

  beforeEach(() => {
    client = new JulesClient(apiKey);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws error if api key is missing', () => {
    expect(() => new JulesClient('')).toThrow('Jules API key is required');
  });

  it('createSession sends correct request', async () => {
    const mockResponse = { name: 'sessions/123' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await client.createSession({
        prompt: 'test prompt',
        sourceContext: {
            source: 'sources/test',
            githubRepoContext: { startingBranch: 'master' }
        }
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://jules.googleapis.com/v1alpha/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
        }),
        body: JSON.stringify({
            prompt: 'test prompt',
            sourceContext: {
                source: 'sources/test',
                githubRepoContext: { startingBranch: 'master' }
            }
        })
      })
    );
    expect(result.id).toEqual('123');
  });

  it('throws JulesClientError on non-ok response', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

    await expect(client.getSession(asJulesSessionId('invalid'))).rejects.toThrow(JulesClientError);
    await expect(client.getSession(asJulesSessionId('invalid'))).rejects.toThrow(/404/);
  });

  it('getSession sends correct request', async () => {
    const mockResponse = { name: 'sessions/123', state: 'RUNNING' };
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await client.getSession(asJulesSessionId('123'));

    expect(global.fetch).toHaveBeenCalledWith(
      'https://jules.googleapis.com/v1alpha/sessions/123',
      expect.objectContaining({
        headers: expect.objectContaining({
            'X-Goog-Api-Key': apiKey,
        })
      })
    );
    expect(result.id).toEqual('123');
  });

  it('sendMessage sends correct request', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.sendMessage(asJulesSessionId('123'), { message: 'hello' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://jules.googleapis.com/v1alpha/sessions/123:sendMessage',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'hello' })
        })
      );
  });

  it('approvePlan sends correct request', async () => {
        (global.fetch as any).mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        });

        await client.approvePlan(asJulesSessionId('123'), { approved: true });

        expect(global.fetch).toHaveBeenCalledWith(
          'https://jules.googleapis.com/v1alpha/sessions/123:approvePlan',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ approved: true })
          })
        );
  });

  describe('extractPullRequestUrl', () => {
     it('extracts successfully', () => {
         const url = extractPullRequestUrl({
             name: parseJulesSessionName('sessions/1'),
             id: asJulesSessionId('1'),
             rawOutputs: [
                 { type: 'unrelated' },
                 { pullRequest: { url: 'http://my-pr' } }
             ]
         });
         expect(url).toBe('http://my-pr');
     });

     it('returns undefined if not found', () => {
         const url = extractPullRequestUrl({
             name: parseJulesSessionName('sessions/1'),
             id: asJulesSessionId('1'),
             rawOutputs: [
                 { type: 'unrelated' },
                 { pullRequest: { url_invalid_key: 'http://my-pr' } }
             ]
         });
         expect(url).toBeUndefined();
     });

     it('returns undefined if no outputs', () => {
          const url = extractPullRequestUrl({
              name: parseJulesSessionName('sessions/1'),
              id: asJulesSessionId('1')
          });
          expect(url).toBeUndefined();
      });
  });
});
