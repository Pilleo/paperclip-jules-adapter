import { describe, it, expect } from 'vitest';
import { buildJulesAdapterConfig } from '../src/ui/build-config';

describe('UI Build Config', () => {
    it('builds config mapping defaults', () => {
        const config = buildJulesAdapterConfig({
            source: ' source ',
            repository: ' repo ',
            baseBranch: ' branch '
        });
        expect(config.source).toBe('source');
        expect(config.repository).toBe('repo');
        expect(config.baseBranch).toBe('branch');
        expect(config.automationMode).toBe('AUTO_CREATE_PR');
        expect(config.requirePlanApproval).toBe(false);
        expect(config.pollIntervalSeconds).toBe(45);
        expect(config.heartbeatPollWindowSeconds).toBe(120);
        expect(config.maxSessionAgeHours).toBe(168);
        expect(config.maxAutomaticRestarts).toBe(3);
    });
});
