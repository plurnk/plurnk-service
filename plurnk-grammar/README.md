# plurnk-grammar

Parser for the Plurnk protocol — a HEREDOC-style DSL for LLM agents.

## install

```
npm install @plurnk/plurnk-grammar
```

Requires Node ≥ 25 (native TypeScript support).

## use

```ts
import { PlurnkParser } from "plurnk-grammar";
const result = PlurnkParser.parse(input);
// result.items: Array<{kind:"statement"|"error"|"text", ...}>
// result.unparsedTail?: { from, reason }
```

Discriminate on `item.kind`. For `statement` items, narrow on `statement.op` (one of `FIND READ EDIT COPY MOVE OPEN FOLD SEND EXEC KILL PLAN`) to access per-OP typed fields. Full API: [SPEC.md §12](SPEC.md#12-public-api).

`parsePath(raw)` is a top-level helper that decomposes a path/URI string into a `ParsedPath` (the same decomposition applied to `(target)` slots). Reach for it to resolve a **COPY destination**: COPY's body is an opaque string — a destination URI for an entry copy, a prompt for a run fork (`run:///`) — so the consumer interprets it by scheme and calls `parsePath` for the destination case. (MOVE destinations arrive pre-parsed; COPY's don't, because its body is polymorphic.)

## cli

```
plurnk [file]      parse to JSON; file or stdin
plurnk --help
```

Exit `0` on clean parse, `1` on any error or unparsed tail.

## syntax

```
<<OPsuffix [signal]? (path)? <L>? : body? :OPsuffix
```

| slot     | shape                                              |
|----------|----------------------------------------------------|
| `OP`     | `FIND READ EDIT COPY MOVE OPEN FOLD SEND EXEC KILL PLAN` |
| `suffix` | `[A-Za-z0-9_]*` glued to `OP`; used for nesting    |
| `[…]`    | optional CSV; per-OP semantics                     |
| `(…)`    | optional URI                                       |
| `<L>`    | optional `<N>` or `<N-M>`; N, M ∈ signed numbers — decimals mean insert-between (lines) or score threshold (results) |
| `:body:` | optional; opaque between fences                    |

| OP   | signal           | body                  | line marker        |
|------|------------------|-----------------------|--------------------|
| FIND | tag filter       | matcher               | result-set range   |
| READ | tag filter       | matcher               | per-entry lines    |
| EDIT | tags             | content (empty=clear) | entry lines        |
| COPY | tags-to-apply    | destination URI / fork prompt | entry lines        |
| MOVE | tags-to-apply    | destination URI       | entry lines        |
| OPEN | tag filter       | matcher               | result-set range   |
| FOLD | tag filter       | matcher               | result-set range   |
| SEND | HTTP status int  | payload (JSON conv.)  | n/a                |
| EXEC | executor         | command or code       | n/a                |
| KILL | unix signal int  | annotation (opaque)   | n/a                |
| PLAN | tags             | reasoning text        | n/a                |

Matcher body dialect by leading char: `//` xpath · `#…#flags` regex · `$` jsonpath · `~` semantic · `@` graph · else glob. A body that fails its prefix-indicated dialect falls back to glob.

Path scheme detection: a leading `#` → path-name regex (`#pattern#flags`); else `[a-z][a-z0-9+.-]*://` → URL (fully decomposed); else local (raw). Bare paths default to `file://` at runtime.

Nesting: outer body may contain inner `<<OP:…:OP` statements; outer must use a non-empty suffix so its close `:OPsuffix` is distinct.

## examples

1. List all xml files containing the admin user role.
	<<FIND(config/**/*.xml)://user[@role='admin']:FIND

2. Read hello in every language
	<<READ(lang/??.json):$.greeting:READ

3. Write a known entry
	<<EDIT[philosophy,existentialism](known:///philosophy/existentialism/meaning):The meaning of life is 42:EDIT

4. Read an entry in full
	<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ

5. Read lines 426–465 of a long article
	<<READ(https://en.wikipedia.org/wiki/Donald_Rumsfeld)<426-465>::READ

6. Create an unknown entry with tags
	<<EDIT[france,geography](unknown:///countries/france/capital):What is the capital of France?:EDIT

7. Create a multi-line plan
	<<EDIT[plan,france,task](known:///plan):
	- [ ] Decompose prompt into unknowns
	- [ ] Discover capital of France
	- [ ] Deliver
	:EDIT

8. Mark a plan step complete (single-line replace)
	<<EDIT(known:///plan)<2>:- [x] Discover capital of France:EDIT

9. Replace a range of lines
	<<EDIT(known:///countries/france/capital)<4-5>:
	The capital of France is Paris, on the river Seine.
	Paris has been the continuous capital of France since 987 CE.
	:EDIT

10. Append content to an existing entry
	<<EDIT(known:///countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

11. Prepend content to an existing entry
	<<EDIT(known:///countries/france/capital)<0>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

12. Clear entry contents (empty body between two colons)
	<<EDIT(known:///countries/france/capital)::EDIT

13. Collapse every distilled fetch-log row
	<<FOLD(log:///1/*/*/get)::FOLD

14. Restore collapsed log rows by tag filter
	<<OPEN[france](log:///**)::OPEN

15. Rename a draft entry
	<<MOVE(known:///draft):known:///final/answer:MOVE

16. Run a shell command in the project root
	<<EXEC(./):node --test:EXEC

17. Continue the loop
	<<SEND[102]:decomposed prompt; plan initialized:SEND

18. Deliver the final answer
	<<SEND[200]:Paris:SEND

19. Search logs for timeout errors (case-insensitive regex body)
	<<FIND(log:///**/error):#timeout|deadline exceeded#i:FIND

20. Find entries whose content begins with "Paris" (glob body)
	<<FIND(known:///countries/**):Paris*:FIND

21. List the first 20 entries under a broad path (result-set pagination)
	<<FIND(known:///**)<1-20>::FIND

22. Read the first five lines of a local file (bare path → file://)
	<<READ(./README.md)<1-5>::READ

23. Copy a draft entry to a dated archive location
	<<COPY(known:///draft):known:///archive/2026-05-14/draft:COPY

24. Run an inline node script
	<<EXEC[node](./):
	const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
	console.log(sum);
	:EXEC

25. Restore log rows tagged france whose content matches (combined filters)
	<<OPEN[france](log:///**):Paris*:OPEN

26. Collapse the second hundred of stale fetch-log rows (pagination)
	<<FOLD(log:///**/get)<101-200>::FOLD

27. Deliver a structured answer (JSON body)
	<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND

28. Report a client error (JSON body the model can traverse with jsonpath)
	<<SEND[400]:{"reason":"unrecognized OP","got":"FOOBAR","expected":["FIND","READ","EDIT","COPY","MOVE","OPEN","FOLD","SEND","EXEC","KILL","PLAN"]}:SEND

29. Report a server error with explicit recipient
	<<SEND[503](log:///errors):{"reason":"git unavailable","command":"git status"}:SEND

30. Direct an informational message at a named agent
	<<SEND[102](agent://supervisor):decomposition complete; awaiting clearance:SEND

31. Kill a runaway process
	<<KILL(exec:///3/1/2)::KILL

32. Permanently delete an entry
	<<KILL(known:///obsolete/note)::KILL

33. Think aloud — reasoning recorded to the log
	<<PLAN:Need the capital fact; discover via wiki, record to known, deliver.:PLAN

34. Insert a line between lines 2 and 3 (decimal = between; replaces nothing)
	<<EDIT(known:///plan)<2.5>:- [ ] Verify against a second source:EDIT

35. Semantic search with a similarity threshold (decimal = minimum score)
	<<FIND(known:///**)<0.7>:~territorial concessions:FIND

36. Quote a plurnk operation inside another (nesting via suffix discipline)
	<<EDITouter(known:///demo):
	The following is a quoted plurnk operation, preserved verbatim:
	<<EDIT(known:///inner):hello world:EDIT
	:EDITouter

37. Find every entry whose path matches a regex (path-name regex target)
	<<FIND(#draft.*#i)::FIND

## error format

Errors are JSON-serializable. Shape: `{ line, column, source, message }` where `source` ∈ `lexer | parser | visitor`. Messages use protocol vocabulary (`unrecognized character '<<' in path`, `expected close tag; got end of input`).

## gbnf

Four generated [GBNF](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md) grammars ship in the package for llama.cpp constrained sampling. All dictate the canonical statement form (digit suffixes, comma line markers, three-digit SEND signals); operations are fully enforced everywhere.

- **`plurnk.gbnf` (default)** — free reasoning text and statements interleave, EOS at any boundary, **but `<<` is a hard commit**: prose may contain a lone `<` and never `<<`, so the only way to produce `<<` is to begin a real operation. Operation-lookalike garbage (`<<RANDOM`) can't exist even as text — at `<<` the sampler is forced into a valid op. Leanest text automaton (2 states). Tradeoff: a fumbled verb is coerced toward a real op, and `<<` is unwritable in prose.
- **`plurnk-free.gbnf`** — free text and statements interleave with `<<` escapable to text: an opener-lookalike that never completes a real keyword stays inert text. The permissive fallback if the hard commit bites.
- **`plurnk-closed.gbnf`** — free-style text, but the turn must close with a final pathless `SEND[102]`/`SEND[200]` (forced EOS). For models that ramble past optional stopping points.
- **`plurnk-strict.gbnf`** — ops only, bounded newline separators. The tightest rail, for models that don't reason.
- **`plurnk-plan.gbnf`** — exactly `plurnk-strict`, but the turn must open with a `<<PLAN:` op: forces a reasoning step before any action.

The parser remains the permissive contract — everything any of the three can generate, the parser accepts (interstatement text surfaces as `kind: "text"` items).

```ts
import.meta.resolve("@plurnk/plurnk-grammar/plurnk.gbnf")
```

`npm run test:llama` validates the grammar against a live llama-server (`PLURNK_LLAMA_URL`, default `http://127.0.0.1:11435`) and demos constrained emission end-to-end. Opt-in; not part of `test:all`.

## spec

[SPEC.md](SPEC.md) — full grammar specification: canonical form, per-OP semantics, matcher dialects, path decomposition, error model, whitespace rules, implementation notes.

## ecosystem

The `@plurnk/*` ecosystem pins peer versions exactly — no caret, no tilde, no ranges:

```json
"@plurnk/plurnk-grammar": "0.23.0"
```

Greenfield, single-orchestrator-per-repo, closed ecosystem. Determinism beats flexibility at this stage: when versions drift, the npm install error tells you which package needs a release. Silent semver wiggling masks coordination gaps that surface as mystery failures later.

Every grammar release cascades: every consuming package (`plurnk-providers`, `plurnk-schemes`, `plurnk-execs`, `plurnk-mimetypes`, `plurnk-service`, ...) bumps its pin and publishes a patch, then top-level consumers (`plurnk-service`, `plurnk`) bump theirs. Skipping a step = broken install downstream.

Not permanent — at v1 stabilization the policy widens back to semver ranges.

## license

MIT.
