# Google Jules Adapter for Paperclip

The Jules adapter enables running Google Jules asynchronously via Paperclip's orchestration engine correctly mapping long-running multi-day sessions inside bounded execution context loops.

## V0.1 Interactive Scope

**Important:** Automatic free-text answer forwarding and explicitly resolving plan approval choices dynamically via `sendMessage` and `approvePlan` are explicitly deferred until the pinned Paperclip interaction-continuation SDK contracts are integrated safely providing explicit type safe payloads matching `AdapterExecutionContext` requirements natively.

V0.1 correctly detects Jules feedback/plan-approval states and surfaces a generic Paperclip acknowledgement prompt natively halting the loop execution efficiently, directing humans safely to the Jules Google UI appropriately tracking `WAITING_FOR_FEEDBACK` bounds accurately.

## Architecture

- Uses `@paperclipai/adapter-utils` matching `2026.722.0` contracts.
- Strictly validates API responses enforcing native type safety omitting arbitrary context overrides or un-typed property guessing.
- Includes failure retry backoffs correctly detecting API errors vs invalid tasks mapping properly into execution contexts securely supporting automatic retries.

Read more in `docs/architecture.md`.
