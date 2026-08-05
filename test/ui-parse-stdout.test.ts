import { describe, it, expect } from 'vitest';
import { parseJulesStdoutLine } from '../src/ui/parse-stdout';

describe('UI Parse Stdout', () => {
    it('maps line to transcript entry', () => {
        const res = parseJulesStdoutLine('test', '123') as any;
        expect(res).toHaveLength(1);
        expect(res[0]!.content).toBe('test');
    });
});
