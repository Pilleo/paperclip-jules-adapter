import { createHash } from 'crypto';
import { AdapterConfig } from './config.js';

export interface PromptContext {
  issueId: string;
  runId: string;
  title: string;
  description: string;
  isRetry: boolean;
  failedSessionReference?: string | undefined;
  failedSessionMessage?: string | undefined;
}

export const PROMPT_IDENTITY_HASH_VERSION = 2;

export function buildPrompt(ctx: PromptContext, config: AdapterConfig): string {
  let prompt = `Task: ${ctx.title}\n\n`;
  prompt += `Description:\n${ctx.description}\n\n`;

  prompt += `Paperclip Issue ID: ${ctx.issueId}\n`;
  prompt += `Paperclip Run Marker: [paperclip-run:${ctx.runId}]\n\n`;

  prompt += `Repository: ${config.source}\n`;
  prompt += `Base Branch: ${config.baseBranch}\n\n`;

  prompt += `Instructions:\n`;
  prompt += `- If repository changes are needed, create a pull request (PR) upon completion.\n`;
  prompt += `- If no repository changes are needed or the task explicitly requests no changes, explain the result and complete without a PR.\n`;
  prompt += `- When creating a PR, include the Paperclip Issue ID (${ctx.issueId}) in its description or title.\n`;
  prompt += `- Do not merge the PR automatically.\n`;
  prompt += `- If you are blocked or need clarification, ask a focused question.\n\n`;

  if (ctx.isRetry) {
    prompt += `A previous Jules session failed unexpectedly.\n`;
    prompt += `Previous session: ${ctx.failedSessionReference || 'Unknown'}\n`;
    prompt += `Failure: ${ctx.failedSessionMessage || 'Unknown error'}\n\n`;
    prompt += `Start cleanly from the current base branch. Do not assume the previous session's workspace exists. Preserve the original task and acceptance criteria.\n`;
  }

  return prompt;
}

export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function hashPromptIdentity(ctx: PromptContext, config: AdapterConfig): string {
  return hashPrompt(buildPrompt({ ...ctx, runId: "<paperclip-run>" }, config));
}
