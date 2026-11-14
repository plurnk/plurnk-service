---
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-service": patch
---

Auto-bound `InferenceAdmission` from probed `llama-server` `total_slots`
(`effectiveMaxConcurrency`) and resize live endpoint semaphores in place across
`.env` reloads (#1468).
