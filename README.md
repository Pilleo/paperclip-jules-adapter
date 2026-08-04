# Google Jules Adapter for Paperclip

The Jules adapter enables running Google Jules asynchronously via Paperclip's orchestration engine correctly mapping long-running multi-day sessions inside bounded execution context loops.

## Scope: v0.1.0-alpha

**This is an experimental non-interactive Jules adapter foundation.**

It supports:
- Session creation
- Bounded polling inside Paperclip heartbeats
- Terminal PR reporting
- State persistence and retry bounds.

## Current Limitations

This is an alpha integration.

- Jules sessions are persisted across Paperclip heartbeats.
- Transient Jules failures can be retried automatically according to robust bounding loops avoiding infinite execution.
- PR creation is surfaced to Paperclip and keeps the task active for review.
- Jules `AWAITING_USER_FEEDBACK` and `AWAITING_PLAN_APPROVAL` states are surfaced as Paperclip notifications, but responses are not yet forwarded back to Jules. Complete these interactions manually in the Jules UI.
- PR merge/close state is not yet synchronized to Paperclip. Resolve or cancel the Paperclip task manually after GitHub review and merge.
- Host integration remains subject to a Paperclip loader/continuation contract test inside specific deployment contexts.

## Architecture

- Uses `@paperclipai/adapter-utils` matching `2026.722.0` contracts securely strictly validating boundaries via typed Zod checks.
- Strictly validates API responses enforcing native type safety omitting arbitrary context overrides or un-typed property guessing avoiding `any`.
- Includes failure retry backoffs correctly detecting API errors vs invalid tasks securely mapping into execution contexts supporting reliable continuations.

Read more in `docs/architecture.md`.
