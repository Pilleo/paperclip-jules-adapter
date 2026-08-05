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

## How to Build

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Verify Types and Tests:**
   ```bash
   npm run typecheck
   npm run test
   ```

3. **Compile the Adapter:**
   ```bash
   npm run build
   ```

4. **Pack the Artifact:**
   ```bash
   npm pack
   ```
   This generates a `.tgz` artifact (e.g., `pilleo-paperclip-jules-adapter-0.1.0.tgz`) that can be loaded into the Paperclip host.

## How to Use

1. **Install in Paperclip Environment:**
   Depending on your Paperclip deployment, install the packed `.tgz` file using the external adapter installation mechanism documented by your host version.

   Example:
   ```bash
   npm install /path/to/pilleo-paperclip-jules-adapter-0.1.0.tgz
   ```

2. **Configuration:**
   Once installed, the adapter exposes the configuration fields mapped in `src/ui/build-config.ts`. You must configure the following core fields within the Paperclip agent creation UI or configuration files:
   - **Repository Source**: The primary code repository (e.g., `github.com/org/repo`).
   - **Base Branch**: The branch to operate on (e.g., `main` or `master`).
   - **Automation Mode**: Currently defaults to `AUTO_CREATE_PR`.

3. **Provide Secrets:**
   The adapter requires `JULES_API_KEY` to be passed via Paperclip's secure secret/environment variables injection configuration natively. **Never** hardcode this inside configuration JSON files.

### Paperclip UI Registry Integration

This package exposes the `buildJulesAdapterConfig` and `parseJulesStdoutLine` modules required to integrate into the Paperclip UI registry.

However, the react `ConfigFields` component must be integrated directly into your Paperclip fork or host deployment:

1. Create the UI Component (`ui/src/adapters/jules/config-fields.tsx`):
```tsx
import type { AdapterConfigFieldsProps } from "../types";
import { Field, ToggleField, DraftInput, DraftNumberInput } from "../../components/agent-config-primitives";

export function JulesConfigFields(props: AdapterConfigFieldsProps) {
  const source = props.config?.source ?? "";
  const repository = props.config?.repository ?? "";
  const baseBranch = props.config?.baseBranch ?? "master";

  return (
    <>
      <Field label="Jules source" hint="e.g. sources/github/org/repo">
        <DraftInput value={source} onCommit={(value) => props.mark("source", value)} />
      </Field>
      {/* ... Add controls for baseBranch, pollIntervalSeconds, maxSessionAgeHours, etc. */}
    </>
  );
}
```

2. Register the Adapter (`ui/src/adapters/jules/index.ts`):
```ts
import type { UIAdapterModule } from "../types";
import { parseJulesStdoutLine, buildJulesAdapterConfig } from "@pilleo/paperclip-jules-adapter/ui";
import { JulesConfigFields } from "./config-fields";

export const julesUIAdapter: UIAdapterModule = {
  type: "jules",
  label: "Google Jules",
  parseStdoutLine: parseJulesStdoutLine,
  ConfigFields: JulesConfigFields,
  buildAdapterConfig: buildJulesAdapterConfig,
};
```

3. Export it in your Paperclip `ui/src/adapters/registry.ts` configuration to mount it to Paperclip.
