# `log://` — your run's event history, and how to manage it

Every operation you emit is recorded as a row at `log:///<loop>/<turn>/<seq>`. The log is your working memory's ledger — what you've done and what came back. READ a row to recover an earlier op's actual result body (chain a matcher to extract a value). The engine writes it; you read and CURATE it.

## The two budget surfaces

You manage working-memory tokens across two surfaces:

- **The log** — every operation, in order. The curatable surface.
- **The catalog** — `FIND(scheme:///**)` lists the entries a scheme holds, available to READ. Discovery, not history.

## Curation — OPEN, FOLD, KILL

Your context carries a `tokensFree` budget; keeping it lean keeps your reasoning sharp, because irrelevant tokens degrade signal. Three moves, all on the log:

- **FOLD** a row → contracts it to its one-line summary, reclaiming the body's tokens. Non-destructive: a folded row stays listed and re-OPENable. Your primary hygiene tool — fold a row the moment its body has served its purpose.
- **OPEN** a folded row → restores its full body, spending from `tokensFree`. Use it to revisit a result you folded too early.
- **KILL** a row → erases it. Sparingly, for rows whose very existence (not just body) is noise.

## Patterns

- **Fold-as-you-go.** Once you've extracted what you need from a large READ or EXEC result, FOLD it. Don't carry raw bodies you've already digested.
- **Bulk fold.** `FOLD(log:///**/get)<101,200>` collapses a range of matching rows in one move — clear a burst of exploratory reads once they've paid out.
- **Recover on demand.** Folded ≠ gone. If a later turn needs a folded result, OPEN it (or READ the row directly with a matcher).
- **Don't wait for the grinder.** When `tokensFree` runs low the engine's budget grinder folds for you to fit the turn — but it's a mechanical last resort. Curating deliberately keeps the rows YOU value and avoids the overflow in the first place.
