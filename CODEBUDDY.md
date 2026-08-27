# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

`dsh-matrix-agent` is a DeepSeek Harness (dsh) plugin that bridges Matrix chat rooms into harness agent sessions. Each Matrix "digital twin" (bot account) runs in its own harness process, holds one agent session per room, and lets a human Owner drive/approve it from the Matrix client.

## Commands

Package manager is `pnpm` (via corepack). Build scripts need pnpm's `allowBuilds` permission — the repo's `pnpm-workspace.yaml` already grants `esbuild`. Git-installed copies need `dsh-matrix: true` added to the consuming profile's `pnpm-workspace.yaml` (see README "安装").

```bash
corepack pnpm install        # install deps
corepack pnpm build          # tsc -> lib/  +  esbuild client -> lib/client.js
corepack pnpm dev            # tsc --watch (lib only; does NOT rebuild the client bundle)
corepack pnpm test           # tsc + esbuild + node --test (full suite)
```

There is **no separate linter**. The type-check gate is `tsc` under `tsconfig.json`, which is strict (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax: true`, `moduleResolution: NodeNext`). Run `corepack pnpm exec tsc -p tsconfig.json --noEmit` to type-check without emitting.

**Single test:** tests import from `../lib/*.js` (built output), so you must build first, then point `node --test` at one file:

```bash
corepack pnpm build && node --test tests/format.test.mjs
# or a specific group:
corepack pnpm exec tsc -p tsconfig.json && node --test tests/matrix-channel.test.mjs
```

`node --test` with no args runs every `*.test.mjs` under the cwd. The `matrix-channel.test.mjs` and `bridge*.test.mjs` suites spin up a fake homeserver / real `MatrixBridge` instances end-to-end.

Publish flow lives in `.github/workflows/npm-publish.yml` (triggered by `v*` tags): `pnpm install --frozen-lockfile && pnpm build && pnpm test && npm publish`.

## Architecture

### Plugin shape & lifecycle (`src/index.ts`)
Cordis plugin with **named exports only** — `name`, `inject`, `apply`, `Config` — and **no default export**. `inject = ['agents', 'tools']` (the plugin supplies the agent factory hook + registers tools; LLM adapter, sessions, and agent presets come from the surrounding `cordis.patch.yml` composition). `apply` does the wiring in order: `registerMatrixSettings` (user settings overlay) → `registerSoul` (soul subsystem) → construct `MatrixBridge` → `ctx.effect` that `start()`s the bridge and disposes soul/settings on teardown. Token resolution: `config.accessToken` falls back to env `DSH_MATRIX_TOKEN`; both missing throws and the plugin fails to load (fail-closed).

### Two-layer split (the core mental model)
- **Channel layer — `src/matrix.ts`** (`MatrixChannel`): a zero-dependency Matrix client-server API client built on `fetch`. Handles `/sync` long-polling, `send`, `typing`, `join`, invite auto-accept, and `mxc://` media download. No SDK on purpose (README "为什么通道层不用现成 SDK"): matrix-js-sdk ESM is broken and matrix-bot-sdk pulls E2EE native binaries blocked by pnpm. The pattern is reusable for other IMs.
- **Bridge layer — `src/bridge.ts`** (`MatrixBridge`, the largest file): orchestrates one or more accounts, inbound routing (@mention / DM / catch-all), the merge window, per-room agent sessions, approval pushing, authorization, media injection, social memory, and task-snapshot publishing. It owns the `/sync` loop and calls into the channel layer.

### Identity & multi-twin model
- **Owner**: a human, logged in only to the Matrix client (never in any harness). Only the Owner may answer approvals / revoke authorizations.
- **Digital twin**: a bot account (`@ai-…`) that logs into *its own* harness process and collaborates with humans and other twins.
- **Human colleague**: a whitelisted human in the room; whether they can drive the twin is gated by `allowedUserIds` (`allowAllUsers` is dev-only; production is fail-closed).
- **One twin = one harness process** is the default topology. `digitalTwinMode` + `digitalTwins[]` lets a *single* process host multiple twins, each with its own sync loop, state file (`<stateDir>/twins/<localpart>.json`), and per-room sessions. Approval memory is keyed by `twin × room`.

### Three-tier authorization (`src/auth-store.ts` + bridge `approval/request` answerer)
Driven by `auth-store.json` (persisted under `stateDir`):
- **L1 memory authorization**: a non-redline tool previously approved → silent pass, no prompt.
- **L2 room confirmation**: push an approval into the room; only the configured `owner` may reply "批准"; on approval the grant is written to memory.
- **L3 redline (forced)**: tools in `redlineTools` (default `bash`/`pwsh`/`write`/`edit`) require confirmation **every time**, and the grant is never stored.

### State & persistence stores (all under `stateDir`, default `.dsh-matrix`)
- `src/store.ts` (`BridgeState`): room↔session map, persistent event-id dedup ring, sync token (restart resumes via saved token).
- `src/auth-store.ts`: memory-authorization DB + redline adjudication.
- `src/member-store.ts`: per-room member memory (including other digital twins), upserted on join/profile/message; `/memory` and `/forget <userId>` commands; `member-memory.json` on disk.
- `state.json` must never contain chat contents (security redline).

### Tools (`src/tools.ts`)
9 Matrix tools registered via `ctx.tools.register` (model-visible and directly executable): `matrix_get_room_members`, `matrix_get_recent_messages`, `matrix_get_room_info`, `matrix_get_user_info`, `matrix_send_room_message`, `matrix_send_dm`, `matrix_mention_member`, `matrix_list_rooms`, `matrix_get_media`. Proactive-send tools (`matrix_send_dm` / `send_room_message` / `mention_member`) are `isConcurrencySafe=false` and gated by `proactiveSendRequiresApproval` on first use.

### Soul subsystem (`src/soul.ts`) + settings (`src/settings.ts`)
`SoulConfig` (persona/style/catchphrase/habits/replyLength, plus built-in presets) is rendered into each room agent's system prompt section `twin:soul` (Matrix sessions only; must not leak into the GUI). `SoulStatsCollector` aggregates reply/tool/active-time stats per `matrix-*` session; `twin_soul_status` tool reads them. `deriveDefaultOwner` is a pure function for the settings page hint only (runtime never derives owner — explicit config wins). `settings.ts` owns the unified `dsh-matrix` settings namespace (account/soul/social + a `tasksSnapshot` **runtime** mirror, debounced 300ms, not user config) and the live-watch merge that overlays the settings layer on top of yml `config`.

### Client half (web settings UI) — build convention
`src/client-main.js` is the **browser source** (ES module, `import React`). It is bundled by `scripts/build-client.mjs` (esbuild) into `lib/client.js`, wrapped in the dsh web `window.__ModuleLoader__.load({ id, factory })` registration format. `react` is externalized so the bundle uses the shell's React instance (internal React would break hooks). After bundling, `node --check` self-validates syntax. **Edit `src/client-main.js`, never `lib/client.js`** — `lib/client.js` is generated.

### Message flow & `src/format.ts`
- **Inbound**: whitelisted text passes through a merge window (`..` continue / `!!` submit now / bare text → merge), then injected via `agent.followup` with `source.kind = 'plugin'` (chat content must never directly execute shell). Media downloads to `.dsh-matrix/media` and is attached as a multimodal `image` block (graceful text fallback if the model lacks vision). `preserveRichText` keeps captions / rich-text notes / reply context / edit (latest-version) semantics.
- **Outbound**: a `session/event` listener renders `assistant/message` visible text, splits long replies into chunks with convergent `（i/n）` prefixes (`chunkMaxChars`), and sends via `org.matrix.custom.html`; `turn/start` triggers typing. `format.ts` converts a conservative markdown subset → Matrix HTML and does the chunking.

## Key invariants / gotchas
- **Build before test.** Tests import from `lib/`, so `tsc` must have run; `pnpm test` does this, but a bare `node --test` will fail if `lib/` is stale.
- **No HMR for the bundle layer.** After editing `src/`, you must `pnpm build` and **restart the dsh process** (ESM cache + web bundle re-scan).
- **`cordis.patch.yml` config replacement is whole-value, not deep-merge** (per-row by id). Overriding `config` replaces the entire block.
- **Token hygiene:** `cordis.patch.yml` ships with a real `accessToken` and `DSH_MATRIX_TOKEN` is the env-var escape hatch. Never log tokens; prefer `tokenEnv` / `DSH_MATRIX_TOKEN` over committing tokens. `state.json` must never hold chat content.
- **Encrypted rooms are unsupported** (`m.room.encrypted` is only flagged); media has no built-in OCR/transcription; transport is long-polling only (no appservice/webhook).
