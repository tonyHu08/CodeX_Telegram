# User Stories

## 1. Night-time approval from phone

- Situation: You started a long Codex task on desktop before leaving.
- Action: Telegram receives approval request; reply `/approve <id>`.
- Outcome: Task resumes and final result returns to the same chat.

## 2. Commute continuation

- Situation: You are on subway and need to continue current feature thread.
- Action: Send `/threads`, bind latest, then send instruction text.
- Outcome: Codex continues in the same thread context you used on desktop.

## 3. Emergency hotfix check

- Situation: Production issue appears while you're away from laptop.
- Action: Send quick diagnosis prompt from Telegram.
- Outcome: Receive queue/running/final statuses and decide next step immediately.

## 4. Usage guardrail

- Situation: You need to know if today's remaining quota is enough before starting a heavy task.
- Action: Run `/usage` (or `/limits`).
- Outcome: See short-window and weekly remaining percentages.

## 5. Pairing recovery after restart

- Situation: Mac restarted and remote control looks offline.
- Action: Open app from menu bar, verify status, click remote switch if needed.
- Outcome: Connection restores without redoing full onboarding.
