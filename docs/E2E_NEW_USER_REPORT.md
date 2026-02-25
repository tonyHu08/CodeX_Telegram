# E2E New User Report (v0.1.5 Gate)

Date: 2026-02-25  
Target: verify the full Telegram remote control loop and ensure `/current` no longer hard-fails with `12000ms` timeout.

## Summary

### Pass
- `/threads` works and returns list.
- `/bind latest` works.
- `/current` called 10 times continuously: no red-cross hard timeout failure text.
- `/status` and `/usage` return expected data.
- `/plan on`, `/plan status`, `/plan off` are accepted.
- Baseline Plan interaction path is available.
- `/cancel` works.

### Key result for this release
- `/current` is now degrade-first. Under busy thread/read conditions, it returns a fallback snapshot instead of hard-failing the command.

## Environment

- Repo: `CodeX_Telegram`
- Desktop app: CodeX Telegram
- Relay mode: local (`http://127.0.0.1:8787`)
- Test harness: synthetic Telegram command loop through local relay (`/v1/bot/incoming`) with live agent websocket

## Evidence

- Result JSON: `/tmp/cb_v015_release_e2e_result.json`
- Screens:
  - `docs/assets/readme/desktop-home-real.png`
  - `docs/assets/readme/telegram-threads-real.png`

## Automated checks

1. `/threads returns list` ✅
2. `/bind latest works` ✅
3. `/current x10 no hard timeout text` ✅
4. `/status works` ✅
5. `/usage works` ✅
6. `/plan on accepted` ✅
7. `/plan status works` ✅
8. `plan interaction baseline` ✅
9. `/cancel works` ✅
10. `/plan off works` ✅

## Notes

- This gate focuses on command reliability and regression safety for release.
- Telegram UI automation is intentionally not treated as required; command-path verification is done through the bridge agent test harness plus manual message checks.


### Release gate evidence

- `/threads` x5 pass
- `/bind latest` pass
- `/current` x10 pass (no `thread/read timed out after 12000ms` red-cross failure)
- `/status` pass
- `/usage` pass
- `/plan on` + `/plan status` + plan message + `/plan off` pass
- `/cancel` pass
