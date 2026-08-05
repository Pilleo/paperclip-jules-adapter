import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testEnvironment } from '../src/server/test-environment';
import { JulesClient } from '../src/server/jules-client';
import { AdapterEnvironmentTestContext } from '@paperclipai/adapter-utils';

vi.mock('../src/server/jules-client');

describe('testEnvironment', () => {
    const baseCtx: AdapterEnvironmentTestContext = {
        companyId: 'test',
        adapterType: 'jules',
        config: {
            source: 'github', repository: 'repo', baseBranch: 'master',
            pollIntervalSeconds: 10, heartbeatPollWindowSeconds: 30,
            secrets: { JULES_API_KEY: 'test-key' }
        }
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns pass status correctly on success validation', async () => {
        (JulesClient.prototype.getSession as any).mockResolvedValueOnce({ state: 'RUNNING' });
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('pass');
    });

    it('returns fail status correctly on bad config', async () => {
        const res = await testEnvironment({ config: {} } as any);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('config_validation_failed');
    });

    it('returns fail status correctly on auth errors', async () => {
        (JulesClient.prototype.getSession as any).mockRejectedValueOnce({ status: 401 });
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('jules_auth_failed');
    });

    it('returns fail status correctly on unrecoverable general api errors', async () => {
        (JulesClient.prototype.getSession as any).mockRejectedValueOnce(new Error('Down'));
        const res = await testEnvironment(baseCtx);
        expect(res.status).toBe('fail');
        expect(res.checks[0]!.code).toBe('jules_env_failed');
    });
});
