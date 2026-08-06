import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseJulesStdoutLine } from '../src/ui/parse-stdout';

beforeAll(() => {
    process.env['JULES_API_KEY'] = 'test-key';
  });

  afterAll(() => {
    delete process.env['JULES_API_KEY'];
  });

  describe('UI Parse Stdout', () => {
    it('maps line to transcript entry', () => {
        const res = parseJulesStdoutLine('test', '123') as any;
        expect(res).toHaveLength(1);
        expect(res[0]!.content).toBe('test');
    });
});
