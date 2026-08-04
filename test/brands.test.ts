import { describe, it, expect } from 'vitest';
import { asPaperclipId, asJulesSessionId, asJulesActivityId, asPrUrl } from '../src/server/brands';

describe('Brands Coverage', () => {
    it('throws appropriately on invalid branded ids', () => {
        expect(() => asPaperclipId('')).toThrow('Invalid PaperclipId');
        expect(() => asJulesSessionId('')).toThrow('Invalid JulesSessionId');
        expect(() => asJulesActivityId('')).toThrow('Invalid JulesActivityId');
        expect(() => asPrUrl('not-http')).toThrow('Invalid PrUrl');
    });

    it('creates branded ids validly', () => {
        expect(asPaperclipId('valid')).toBe('valid');
        expect(asJulesSessionId('valid')).toBe('valid');
        expect(asJulesActivityId('valid')).toBe('valid');
        expect(asPrUrl('http://valid')).toBe('http://valid');
    });
});
