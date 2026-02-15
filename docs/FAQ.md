# FAQ

## Is this just message forwarding?

No. Codex Bridge binds to a **real Codex thread** on your Mac (via Codex App Server), so context stays consistent.

## What do I need to install?

- Codex App (installed + logged in)
- Codex Bridge Desktop (this project)
- Telegram

No Node/Homebrew is required for end users.

## Does it read my prompts/files?

Codex Bridge only receives what you send to the Telegram bot, and forwards it to your local Codex thread.

Please review:

- [Privacy](./PRIVACY.md)
- [Threat model](./THREAT_MODEL.md)

## Why do I still see approvals in Telegram?

Because your Telegram message can trigger actions that modify files or run commands.

Approvals are a **safety boundary**: you can confirm or deny from anywhere.

## Can it show per-thread “busy” status?

Not reliably today.

Codex Bridge can only observe tasks that **it started itself**. Codex currently does not expose a stable “thread is running” signal for arbitrary threads.

## Can it send/receive images?

Photo input is experimental and depends on your Codex App / App Server version.

If it works on your machine, you'll be able to send a Telegram photo and let Codex see it as an input image.

## Why does `/threads` sometimes degrade?

When `thread/list` is slow or unavailable, `/threads` falls back to the local Codex sidebar cache.

That keeps the bot responsive, but some fields (like timestamps) may be missing.

