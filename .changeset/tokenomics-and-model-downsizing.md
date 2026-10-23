---
"@plurnk/plurnk-providers": patch
"@plurnk/plurnk-service": patch
---

Translate the calibrated curation budget additively by measured overhead
without extrapolating unmeasured content, remove daemon-side row shedding at
the context wall, resolve `PLURNK_PROVIDERS_OUTPUT_FLOOR` percentages against
the effective output ceiling, and refuse model changes whose calibrated budget
cannot hold the worker's current context with `413 context-exceeds-model-budget`
({§tokenomics-calibrated-readout}, {§context-wall}, {§provider-output-floor},
{§worker-model-selection}) (#1225).
