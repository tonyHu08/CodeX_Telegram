# E2E New User Report (Real Desktop App + Real Telegram)

Date: 2026-02-15  
Target: validate "fresh install -> pair -> /threads -> bind -> remote ask -> final reply" loop.

## Summary

### Pass
- Local relay starts and stays healthy.
- Device WebSocket stream connects (`/v1/devices/stream`, `websocketClients: 1`).
- Telegram outbound replies (from device -> relay -> Telegram) work.
- `/threads` is now resilient:
  - If `thread/list` is slow/unavailable, it degrades to Codex sidebar cache so Telegram always gets a reply quickly.

### Notes (Test Harness)
- Telegram UI automation via shell AppleScript is unreliable in this environment, so it is not used as a requirement.
- Manual Telegram interaction is the primary verification method (real user -> bot updates).
- The relay injection endpoint (`POST /v1/bot/incoming`) is still useful as a fast regression test for the device outbound path.

## Environment
- Desktop: Codex Bridge Desktop (packaged app in `/Applications`)
- Relay mode: local (`http://127.0.0.1:8787`)
- Telegram bot: `@tony_test_2_bot`
- Device binding:
  - `~/.codex-bridge/data/local-relay-store.json`

## Evidence (Screens)
- `docs/assets/e2e/01-onboarding-initial.png`
- `docs/assets/e2e/02-telegram-pairing-attempt.png`
- `docs/assets/e2e/03-pairing-confirmed.png`
- `docs/assets/e2e/04-telegram-start-pressed.png`
- `docs/assets/e2e/05-threads-response.png`
- `docs/assets/readme/desktop-home.png`
- `docs/assets/readme/telegram-threads.png`

## Key Fixes Landed During This Run

### 1) `/threads` reply stability
- Behavior:
  - Try `thread/list` once with a short timeout.
  - On failure, degrade to Codex Desktop sidebar cache (`~/.codex/.codex-global-state.json`) and still return a usable list.
- User-facing note:
  - When degraded, the reply includes a short warning that timestamps may be missing.

### 2) Device stream reliability (Keychain pitfalls)
- Avoid blocking flows caused by Keychain writeback prompts/hangs.
- Keychain reads are now best-effort with a short timeout, and token restoration can fall back to local relay store.

## Verification Steps Executed

### Phase A: Health + binding
1. Confirm relay health:
   - `GET /healthz` returns `telegramEnabled: true` and the expected `botUsername`.
2. Confirm device stream:
   - `GET /v1/devices/me` (Bearer token from local relay store) returns `connected: true`.

### Phase B: Command loop (real Telegram)
1. In Telegram, run `/threads`, bind a thread, and send a short prompt.
2. Verify relay forwards device outbound event and Telegram receives message:
   - Relay logs show `eventType: finalResponse` with the command/turn content preview.

## Follow-ups
- Add an in-app "Send test command" (local-only) button in onboarding to validate inbound/outbound without requiring UI automation.
- Improve end-user diagnostics when Telegram polling is unhealthy:
  - Show last polling error + a "Restart bot polling" action.
