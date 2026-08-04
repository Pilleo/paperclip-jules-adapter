# Compatibility

This adapter implements support for Paperclip interactions and builds on its SDK packages.

## Tested Environment

- **Paperclip host version**: 2026.722.0
- **Tested commit**: <commit corresponding to the deployed host> (to be determined based on deployment)

## Relevant Contracts

- `packages/adapter-utils/src/types.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/recovery/`
- `.agents/skills/create-agent-adapter/SKILL.md`

## Jules API

- Version: `v1alpha`

## SDK Dependencies

- `@paperclipai/adapter-utils`: `2026.722.0`
