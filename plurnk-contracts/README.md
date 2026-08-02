# @plurnk/plurnk-contracts

The single authority for PLURNK's language grammar, generated AST and wire
types, JSON Schemas, parser, model generation rail, Problems, operation
results, Notices, and text coordinates.

## install

```
npm install @plurnk/plurnk-contracts
```

Requires Node ≥ 26.

## Wire contracts

```ts
import {
    Problems,
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";

const problem = Problems.create("scheme:file", "not-found", 404, "Missing.");
const result: OperationResult = { status: 404, problem };
Validator.assertOperationResult(result);
```

## Grammar and parser

```ts
import { PlurnkParser } from "@plurnk/plurnk-contracts";
const result = PlurnkParser.parse(input);
// result.items: Array<{kind:"statement"|"error"|"text", ...}>
// result.unparsedTail?: { from, reason }
```

Discriminate on `item.kind`. For `statement` items, narrow on `statement.op` (one of `FIND READ EDIT COPY MOVE OPEN FOLD SEND EXEC WORK FORK KILL PLAN`) to access per-OP typed fields. Full API: [SPEC.md §12](SPEC.md#12-public-api).

`parsePath(raw)` decomposes a path/URI string into the same `ParsedPath`
used by `(target)` slots. `parseResourceSelection(raw)` additionally recognizes
the optional trailing text scope used by COPY and MOVE destinations.

## CLI

```
plurnk-contracts [file]      parse to JSON; file or stdin
plurnk-contracts --help
```

Exit `0` on clean parse, `1` on any error or unparsed tail.

## syntax

```
<<OPsuffix [signal]? (path)? <L>? : body? :OPsuffix
```

| slot     | shape                                              |
|----------|----------------------------------------------------|
| `OP`     | `FIND READ EDIT COPY MOVE OPEN FOLD SEND EXEC WORK FORK KILL PLAN` |
| `suffix` | `[A-Za-z0-9_]*` glued to `OP`; used for nesting    |
| `[…]`    | optional CSV; per-OP semantics                     |
| `(…)`    | optional URI                                       |
| `<L>`    | optional numeric scope; one/two integers select positions, four integers select an exact text region, and a leading decimal may be a semantic threshold; parses to `marks: number[]` |
| `:body:` | optional; opaque between fences                    |

| OP   | signal                 | body                    | line marker      |
|------|------------------------|-------------------------|------------------|
| FIND | tag filter             | matcher                 | result-set range |
| READ | tag filter             | matcher                 | text region      |
| EDIT | tags                   | content (empty=clear)   | text region      |
| COPY | tags-to-apply          | destination selection   | source region    |
| MOVE | tags-to-apply          | destination selection   | source region    |
| OPEN | tag filter             | matcher                 | n/a              |
| FOLD | tags-to-apply          | matcher                 | n/a              |
| SEND | numeric operation code | payload (JSON conv.)    | n/a              |
| EXEC | executor               | executor-specific input | n/a              |
| WORK | optional Git branch    | required prompt         | n/a              |
| FORK | optional Git branch    | required prompt         | n/a              |
| KILL | numeric operation code | annotation (opaque)     | n/a              |
| PLAN | tags                   | reasoning text          | n/a              |

On READ, a matcher selects resources against their full readable content and
the line marker projects text from every selected resource. Without one, READ
returns each complete selected resource. FIND line markers instead paginate
selected resources.

Matcher body dialect by leading char: `//` xpath, `/pattern/flags` regex, `$` jsonpath, `~` semantic, `@` graph, else glob. A leading symbol commits its dialect; invalid syntax is reported.

Path scheme detection: `[a-z][a-z0-9+.-]*://` → URL (fully decomposed); otherwise local (raw). Targets address exact paths or shell globs. Bare paths default to `file://` at runtime.

Nesting: outer body may contain inner `<<OP:…:OP` statements; outer must use a non-empty suffix so its close `:OPsuffix` is distinct.

## examples

1. List all xml files containing the admin user role.
	<<FIND(config/**/*.xml)://user[@role='admin']:FIND

2. Read hello in every language
	<<READ(lang/??.json):$.greeting:READ

3. Write a known entry
	<<EDIT[philosophy,existentialism](worker:///philosophy/existentialism/meaning):The meaning of life is 42:EDIT

4. Read an entry in full
	<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ

5. Read lines 426–465 of a long article
	<<READ(https://en.wikipedia.org/wiki/Donald_Rumsfeld)<426-465>::READ

6. Create an unknown entry with tags
	<<EDIT[france,geography](worker:///countries/france/capital):What is the capital of France?:EDIT

7. Create a multi-line plan
	<<EDIT[plan,france,task](worker://~/plan):
	- [ ] Decompose prompt into unknowns
	- [ ] Discover capital of France
	- [ ] Deliver
	:EDIT

8. Mark a plan step complete (single-line replace)
	<<EDIT(worker://~/plan)<2>:- [x] Discover capital of France:EDIT

9. Replace a range of lines
	<<EDIT(worker:///countries/france/capital)<4-5>:
	The capital of France is Paris, on the river Seine.
	Paris has been the continuous capital of France since 987 CE.
	:EDIT

10. Append content to an existing entry
	<<EDIT(worker:///countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

11. Prepend content to an existing entry
	<<EDIT(worker:///countries/france/capital)<0>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

12. Clear entry contents (empty body between two colons)
	<<EDIT(worker:///countries/france/capital)::EDIT

13. Collapse every distilled fetch-log row under a tag
	<<FOLD[distilled](log:///1/*/*/get)::FOLD

14. Restore collapsed log rows by tag filter
	<<OPEN[france](log:///**)::OPEN

15. Rename a draft entry
	<<MOVE(worker:///draft):worker:///final/answer:MOVE

16. Run a shell command in the project root
	<<EXEC(./):node --test:EXEC

17. Continue the loop
	<<SEND[102]:Next, apply the initialized plan to the prompt.:SEND

18. Deliver the final answer
	<<SEND[200]:Paris:SEND

19. Search logs for budget-overflow errors (case-insensitive regex body)
	<<FIND(log:///**/error):/budget overflow|budget exceeded/i:FIND

20. Find entries whose content begins with "Paris" (glob body)
	<<FIND(worker:///countries/**):Paris*:FIND

21. List the first 20 entries under a broad path (result-set pagination)
	<<FIND(worker:///**)<1-20>::FIND

22. Read the first five lines of a local file (bare path → file://)
	<<READ(./README.md)<1-5>::READ

23. Copy a draft entry to a dated archive location
	<<COPY(worker:///draft):worker:///archive/2026-05-14/draft:COPY

24. Run an inline node script
	<<EXEC[node](./):
	const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
	console.log(sum);
	:EXEC

25. Restore log rows tagged france whose content matches (combined filters)
	<<OPEN[france](log:///**):Paris*:OPEN

26. Collapse stale fetch-log rows under a tag
	<<FOLD[stale](log:///**/get)::FOLD

27. Deliver a structured answer (JSON body)
	<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND

28. Report a client error (JSON body the model can traverse with jsonpath)
	<<SEND[400]:{"reason":"unrecognized OP","got":"FOOBAR","expected":["FIND","READ","EDIT","COPY","MOVE","OPEN","FOLD","SEND","EXEC","KILL","PLAN"]}:SEND

29. Report a server error with explicit recipient
	<<SEND[503](log:///errors):{"reason":"git unavailable","command":"git status"}:SEND

30. Direct an informational message at a named agent
	<<SEND(agent://supervisor):decomposition complete; awaiting clearance:SEND

31. Kill a runaway process
	<<KILL(sh:///3/1/2)::KILL

32. Permanently delete an entry
	<<KILL(worker:///obsolete/note)::KILL

33. Think aloud — reasoning recorded to the log
	<<PLAN:Need the capital fact; discover via wiki, record to known, deliver.:PLAN

34. Insert text at line 3, column 1 (equal exact endpoints replace nothing)
	<<EDIT(worker://~/plan)<3,1,3,1>:- [ ] Verify against a second source
:EDIT

35. Semantic search with a similarity threshold (decimal = minimum score)
	<<FIND(worker:///**)<0.7>:~territorial concessions:FIND

36. Quote a plurnk operation inside another (nesting via suffix discipline)
	<<EDITouter(worker:///demo):
	The following is a quoted plurnk operation, preserved verbatim:
	<<EDIT(worker:///inner):hello world:EDIT
	:EDITouter

37. Read a file from the project root
	<<READ(/AGENTS.md)::READ

## error format

Errors are JSON-serializable. Shape: `{ line, column, source, message }` where `source` ∈ `lexer | parser | visitor`. Messages use protocol vocabulary (`unrecognized character '<<' in path`, `expected close tag; got end of input`).

## Optional GBNF artifact

`plurnk.gbnf` is generated for local llama.cpp constrained sampling. It is an
optional compatibility artifact, not the canonical parser and not expected of
cloud providers. The ANTLR grammar above defines the PLURNK language. GBNF is a
pragmatically optimized filter for healthier generation. Parse compatibility is
a goal balanced against rail size and sampling efficiency, not an invariant.
See SPEC {§gbnf-rail-purpose}.

The shipped rail constrains one raw Harmony-reasoning-plus-PLURNK sentence
before llama.cpp projects `reasoning_content` and `content`; it is not split
into two grammars. The exact channel, separator, tail, and projection contracts
are SPEC {§gbnf-turn-shape} and {§gbnf-reasoning-boundary}.

```ts
import.meta.resolve("@plurnk/plurnk-contracts/plurnk.gbnf")
```

`npm run test:llama` validates the grammar against a live llama-server (`PLURNK_LLAMA_URL`, default `http://127.0.0.1:11435`) and demos constrained emission end-to-end. Opt-in; not part of `test:all`.

## spec

[SPEC.md](SPEC.md) is the tagged authority for the language and shared wire
contracts.

## license

MIT.
