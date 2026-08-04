import { describe, it, expect } from 'vitest';
import { handleJulesState } from '../src/server/state-machine';

describe('State Machine', () => {
  it('handles IN_PROGRESS', () => {
    const res = handleJulesState('IN_PROGRESS', false);
    expect(res).toEqual({
      nextPhase: 'RUNNING',
      requiresReturn: false,
      isTerminal: false,
      clearSession: false
    });
  });

  it('handles PAUSED', () => {
    const res = handleJulesState('PAUSED', false);
    expect(res).toEqual({
      nextPhase: 'RUNNING',
      requiresReturn: false,
      isTerminal: false,
      clearSession: false
    });
  });

  it('handles AWAITING_USER_FEEDBACK', () => {
    const res = handleJulesState('AWAITING_USER_FEEDBACK', false);
    expect(res).toEqual({
      nextPhase: 'WAITING_FOR_FEEDBACK',
      requiresReturn: true,
      isTerminal: false,
      clearSession: false
    });
  });

  it('handles AWAITING_PLAN_APPROVAL', () => {
    const res = handleJulesState('AWAITING_PLAN_APPROVAL', false);
    expect(res).toEqual({
      nextPhase: 'WAITING_FOR_PLAN_APPROVAL',
      requiresReturn: true,
      isTerminal: false,
      clearSession: false
    });
  });

  it('handles COMPLETED with PR', () => {
    const res = handleJulesState('COMPLETED', true);
    expect(res).toEqual({
      nextPhase: 'COMPLETED',
      requiresReturn: true,
      isTerminal: true,
      clearSession: true,
      isSuccess: true
    });
  });

  it('handles COMPLETED without PR', () => {
    const res = handleJulesState('COMPLETED', false);
    expect(res).toEqual({
      nextPhase: 'COMPLETED',
      requiresReturn: true,
      isTerminal: true,
      clearSession: true,
      isSuccess: false
    });
  });

  it('handles FAILED', () => {
    const res = handleJulesState('FAILED', false);
    expect(res).toEqual({
      nextPhase: 'FAILED',
      requiresReturn: true,
      isTerminal: true,
      clearSession: false
    });
  });

  it('handles unknown states', () => {
    const res = handleJulesState('SOME_WEIRD_STATE', false);
    expect(res).toEqual({
      nextPhase: 'RUNNING',
      requiresReturn: false,
      isTerminal: false,
      clearSession: false
    });
  });
});
