# @pilleo/paperclip-jules-adapter

A robust Paperclip adapter for starting and orchestrating long-lived Google Jules developer agent sessions.

## Architecture

Google Jules sessions can run for days, executing complex coding tasks. Paperclip's orchestration model uses a bounded heartbeat system. This adapter implements that model by executing long-running Google Jules sessions across multiple small Paperclip heartbeats, persisting and resuming orchestration state cleanly between intervals.

### How it works
1. **Start**: The adapter maps a Paperclip task and prompt into a new Jules session.
2. **Heartbeat Polling**: For roughly a two-minute window, it polls the Google API.
3. **Persist & Park**: If Jules is still running after the window, the adapter durably parks the session state (`julesSessionId`, state enum, failure histories). Paperclip handles sleep/wake boundaries.
4. **Resumption**: Paperclip resumes the adapter later, injecting the durable state, which triggers Jules polling again.
5. **Completion**: If Jules completes (creating a PR), the task enters `in_review` via the Paperclip interactive PR workflow rather than silently marking itself complete.
6. **Recovery**: Network transient failures, crashes, and 500s trigger a reliable backoff continuation without failing the task. Exhausted retries request human intervention via interaction blocks.

## Setup Instructions

### Environment Variables

You must inject the Google Jules API key as a secret/auth token when starting the agent in your Paperclip environment.

```sh
JULES_API_KEY="AIza..."
```

### Paperclip UI Registry Integration

This adapter acts as an **External Adapter** using Paperclip's dynamic external configuration capabilities.

The server plugin loader (`createServerAdapter()`) automatically provides the required declarative interface schema (`getConfigSchema`) to Paperclip's backend via `GET /api/adapters/jules/config-schema`.

When correctly installed on your Paperclip server instance, the UI will dynamically render the configuration form for:
- Jules source
- Repository allowlist
- Base branch
- Poll intervals & automation modes.

*Note:* You do **not** need to manually patch Paperclip UI or implement React `ConfigFields` yourself.

## Current Alpha Limitations
* (v0.1.0) Jules interactions requiring bidirectional communication, such as user feedback questions and plan approvals, currently halt the adapter explicitly and request human intervention. You must review and answer those in the native Google Jules dashboard, and the adapter will resume naturally once it detects the state has progressed.

## Development Requirements
- Node 22
- `pnpm`
- Vitest

## Validation
```sh
npm run typecheck
npm test
npm run build
```
