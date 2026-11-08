# Models and generation

## Summary

Configure model aliases, provider routes, credentials, reasoning effort, context/output budgets, and caching.

| Aspect | Contract |
| --- | --- |
| Route & alias | A route is `provider/model`; `PLURNK_MODEL_<alias>` binds a route and its per-alias tuning knobs. |
| Session selection | Explicit model and effort selections persist on the session; a loop snapshots the resolved route; child sessions inherit the parent's spawn model (`PLURNK_MODEL_CHILD`) or the parent's own model. |
| Effort & output budget | Effort levels come from the selected route (unsupported levels are refused, never downgraded). Output budget accepts tokens or a context percentage; reasoning budget, when set, must be smaller than total output. |
| Context window | Derived from the endpoint or catalog; an operator cap (`PLURNK_PROVIDERS_CONTEXT_WINDOW`) can only shrink it. |
| Cost & recovery | Cost uses settled provider charges when reported, else catalog rates. Timeouts fail honestly; interrupted calls retry within the recovery window before parking for a prompt or wake. |
