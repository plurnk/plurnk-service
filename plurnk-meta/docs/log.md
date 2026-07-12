# `log://` — your run's event history, and how to manage it

Every operation you emit is recorded as a row at `log:///<loop>/<turn>/<seq>` — your working memory's ledger of what you've done and what came back. READ a row to recover an earlier op's actual result body (chain a matcher to extract a value). The engine writes it; you read and CURATE it.

## Two budget surfaces

- **The log** — every operation, in order. The curatable surface.
- **The catalog** — `FIND(scheme:///**)` lists the entries a scheme holds, available to READ. Discovery, not history.

## Curation — FOLD, OPEN, KILL

Your context carries a `tokensFree` budget; keeping it lean keeps reasoning sharp, since irrelevant tokens degrade signal. Three moves, all on the log:

- **FOLD** a row → contracts it to its one-line summary, reclaiming the body's tokens. Non-destructive — a folded row stays listed and re-OPENable. Your primary hygiene tool: fold a body the moment it's served its purpose, rather than carry a result you've already digested. Bulk-fold a matching range in one move — `FOLD(log:///**/get)<101,200>`.
- **OPEN** a folded row → restores its full body, spending from `tokensFree`. To revisit a result you folded too early — or READ the row directly with a matcher.
- **KILL** a row → erases it. Sparingly, for rows whose very existence (not just body) is noise.

**Don't wait for the grinder.** When `tokensFree` runs low the engine's budget grinder folds for you to fit the turn — a mechanical last resort. Curating deliberately keeps the rows YOU value and avoids the overflow in the first place.