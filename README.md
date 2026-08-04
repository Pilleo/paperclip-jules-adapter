# Google Jules Adapter for Paperclip

The Jules adapter enables running Google Jules asynchronously via Paperclip's orchestration engine correctly mapping long-running multi-day sessions inside bounded execution context loops.

## Scope: v0.1.0-alpha

**This is an experimental non-interactive Jules adapter foundation.**

It supports:
- Session creation
- Bounded polling inside Paperclip heartbeats
- Terminal PR reporting
- State persistence and retry bounds.

**It does not yet support Paperclip-to-Jules answer forwarding or plan approval.**
Host integration remains subject to a Paperclip loader/continuation contract test. Answers and plan approvals must currently be completed manually in the Jules UI.

Interactive sessions are correctly detected, and the adapter will safely return an Acknowledgement prompt halting loop execution and directing humans gracefully to the Google Jules UI to fulfill pending blocks manually without dropping context natively on resumption.

## Architecture

- Uses `@paperclipai/adapter-utils` matching `2026.722.0` contracts.
- Strictly validates API responses enforcing native type safety omitting arbitrary context overrides or un-typed property guessing.
- Includes failure retry backoffs correctly detecting API errors vs invalid tasks mapping properly into execution contexts securely supporting automatic retries.

Read more in `docs/architecture.md`.
