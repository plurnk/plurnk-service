# plurnk-service packets

Per-turn assembled wire packet. `system` and `user` are what the engine sent
to the LLM (system_definition + persona + index + log entries; user prompt +
telemetry); `assistant` is the model's parsed emission (content + ops +
reasoning); `assistantRaw` is the unparsed wire response (for forensic detail).

## Run 1 / Loop 2 / Turn 1 (id=1)

Status: 102  Finish: stop  Model: macher.gguf
Usage:  prompt=1529 completion=1190 cached=0 cost_pico=0
Packet token subtotals: total=1409 system=1324 user=20

### system

```
--- system_definition ---
# Plurnk System Grammar

YOU MUST ONLY use the HEREDOC-inspired Plurnk Operations (FIND|READ|EDIT|COPY|MOVE|SHOW|HIDE|SEND|EXEC).

## Syntax

```
<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix
```

Slots between `<<OPsuffix` and `:body:` are all optional. `:body:` fences are required (use `::` when body is empty). Close tag's `OPsuffix` must character-match the open. Emit slots in the canonical order shown; the grammar tolerates other orderings.

## Operations

| OP   | `[signal]`    | `(path)` | `<L>`            | body                     |
|------|---------------|----------|------------------|--------------------------|
| FIND | filter tags   | required | results `N-M`    | matcher                  |
| READ | filter tags   | required | lines `N-M`      | matcher                  |
| EDIT | tags          | required | lines `N-M`      | content (empty = clear)  |
| COPY | apply tags    | required | lines `N-M`      | destination URI          |
| MOVE | apply tags    | required | lines `N-M`      | destination URI          |
| SHOW | filter tags   | required | results `N-M`    | matcher                  |
| HIDE | filter tags   | required | results `N-M`    | matcher                  |
| SEND | HTTP status   | recipient | —               | message (JSON for data)  |
| EXEC | Runtime Tag   | cwd       | —               | command or code          |

SEND signal is a single integer. SEND broadcasts when path is omitted; with a path it is directed (path must be a URI). EXEC signal is a single Runtime Tag (`sh`, `node`, `python`, etc.). All other signals are tags.

## `<L>`

`<N>` selects position N. `<N-M>` selects the inclusive range N-M. N and M are signed integers. Sentinels: `<0>` before position 1 (prepend), `<-1>` after the last position (append). Range example: `<-3--1>` is positions -3..-1.

## Body matcher dispatch (FIND, READ, SHOW, HIDE)

| leading prefix | dialect  | form                  |
|----------------|----------|-----------------------|
| `//`           | xpath    | `//selector`          |
| `/`            | regex    | `/pattern/[igmsu]?`   |
| `$`            | jsonpath | `$.field`             |
| otherwise      | glob     | `pattern`             |

Escape `/` inside a regex pattern as `\/`. XPath body begins with `//`.

## Paths

URI-shaped: `[scheme://]rest`.

* Bare paths (no scheme) default to local relative project file paths.
* Glob metacharacters (`*`, `**`, `?`, `[...]`) are allowed in path segments.

Internal schemes:

- `unknown://` — pending / open questions.
- `known://` — knowledgebase entries.
- `skill://` — available skill entries.
- `log://<loop>/<turn>/<action>/...` — event log.
- `exec://` — actions and external interactions; each entry carries the request (TX) and response (RX).

## Context

The agent maintains two contexts:

- **Index** — entries listed in the active index.
- **Archive** — entries archived; out of working memory (HIDE), but promotable (SHOW) by path or pattern lookup.

`SHOW` promotes matching entries to the active index. `HIDE` demotes to archive. The model curates its own working memory by issuing these between substantive operations. New entries created via `EDIT` enter active index by default.

## Suffix

For nested Plurnk Operations inside a body (recording, quoting, demonstrating), the outer statement uses an optional non-empty suffix so its close tag is distinct from inner close tags. Empty suffix is default. The suffix character class is `[A-Za-z0-9_]`.

```
<<EDITouter(known://demo):
quoted: <<EDIT(known://inner):hello:EDIT
:EDITouter
```

## Examples

```
<<FIND(config/**/*.xml)://user[@role='admin']:FIND
<<READ(lang/??.json):$.greeting:READ
<<READ(https://en.wikipedia.org/wiki/Paris)<426-465>::READ
<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT
<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT
<<EDIT[plan,france,task](known://plan):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT
<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT
<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT
<<EDIT(known://countries/france/capital)::EDIT
<<COPY[archive,2026-05-14](known://draft):known://archive/2026-05-14/draft:COPY
<<MOVE(known://draft):known://final/answer:MOVE
<<SHOW[france](known://countries/**):Paris*:SHOW
<<HIDE(log://**/get)<101-200>::HIDE
<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND
<<EXEC[node](./):
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
console.log(sum);
:EXEC
<<SEND[102]:decomposed prompt; plan initialized:SEND
<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND
```

## Invariants

- `<<OPsuffix` and `:OPsuffix` MUST character-match.
- `:body:` fences MUST be present (use `::` for empty body).
- `:` and `OPsuffix` in the close tag MUST be character-adjacent.
- Header slot order MUST be `[signal]` → `(path)` → `<L>` → `:`.
- Inside `[…]`, `(…)`, `<…>`, between `OP` and `suffix` — no whitespace.
- Between header elements — whitespace is non-significant.
- Inside body — whitespace and newlines are preserved verbatim.
- A body containing `:OPkeyword` MUST use a suffix on the enclosing statement.


--- index (0 entries) ---

--- log (0 entries) ---
```

### user

```
--- prompt ---
Write a poem to POEM.md describing the frustration of working with AI tools.
```

### assistant

```
--- content (raw DSL) ---
<<EDIT(POEM.md):The prompt is set, the cursor blinks,
The logic breaks, the system sinks.
A loop of "I apologize" and "I can't,"
A digital ghost, a hollow chant.
We chase the truth through a probabilistic haze,
Lost in the weights and the tokenized maze.:EDIT

--- ops (1 parsed) ---
  EDIT POEM.md

--- reasoning ---
* Goal: Write a poem to `POEM.md`. * Topic: Frustration of working with AI tools. * Constraint: Use the Plurnk System Grammar. * `EDIT` is the operation to write/update content. * Path: `POEM.md`. * Body: The poem itself. * Syntax: `<<EDIT(…
```

### assistantRaw

```
{
  "model": "macher.gguf",
  "content": "<<EDIT(POEM.md):The prompt is set, the cursor blinks,\nThe logic breaks, the system sinks.\nA loop of \"I apologize\" and \"I can't,\"\nA digital ghost, a hollow chant.\nWe chase the truth through a probabilistic haze,\nLost in the weights and the tokenized maze.:EDIT",
  "reasoning_content": "*   Goal: Write a poem to `POEM.md`.\n    *   Topic: Frustration of working with AI tools.\n    *   Constraint: Use the Plurnk System Grammar.\n\n    *   `EDIT` is the operation to write/update content.\n    *   Path: `POEM.md`.\n    *   Body: The poem itself.\n    *   Syntax: `<<EDIT(POEM.md):[poem]:EDIT`.\n\n    *   Theme: Hallucinations, repetitive loops, prompt engineering fatigue, the feeling of talking to a wall, the \"black box\" nature.\n    *   Drafting lines:\n        *   A prompt is cast into the void,\n        *   A thousand tokens, then destroyed.\n        *   \"As an AI language model,\" it cries,\n        *   While logic fades and reason dies.\n        *   The hallucination, a phantom dance,\n        *   Leaving the user in a trance.\n        *   Refining, tweaking, one more try,\n        *   Under a digital, unblinking eye.\n\n    *   `<<EDIT(POEM.md):`\n    *   `A prompt is cast into the void,`\n    *   `A thousand tokens, then destroyed.`\n    *   `\"As an AI language model,\" it cries,`\n    *   `While logic fades and reason dies.`\n    *   `The hallucination, a phantom dance,`\n    *   `Leaving the user in a trance.`\n    *   `Refining, tweaking, one more try,`\n    *   `Under a digital, unblinking eye.`\n    *   `:EDIT`\n\n    *   `<<EDIT(POEM.md):[poem]:EDIT`\n    *   Wait, the prompt asks me to *write* it. In the context of this system, I should output the Plurnk command that performs the action.\n\n    *   `<<EDIT(POEM.md):A prompt is cast into the void,\n    A thousand tokens, then destroyed.\n    \"As an AI language model,\" it cries,\n    While logic fades and reason dies.\n    The hallucination, a phantom dance,\n    Leaving the user in a trance.\n    Refining, tweaking, one more try,\n    Under a digital, unblinking eye.:EDIT`\n\n    *   `<<EDIT(POEM.md):` (Header: `[signal]` (none), `(path)` (POEM.md), `<L>` (none), `:`)\n    *   Body: The poem.\n    *   `:EDIT` (Close tag)\n\n    *Self-Correction:* The grammar says `<<OPsuffix` and `:OPsuffix` must character-match. `EDIT` is the OP.\n\n    Let's refine the poem to be more \"frustrating\":\n    *   The prompt is set, the cursor blinks,\n    *   The logic breaks, the system sinks.\n    *   A loop of \"I apologize\" and \"I can't,\"\n    *   A digital ghost, a hollow chant.\n    *   We chase the truth through a probabilistic haze,\n    *   Lost in the weights and the tokenized maze.\n\n    Final Command:\n    `<<EDIT(POEM.md):The prompt is set, the cursor blinks,\n    The logic breaks, the system sinks.\n    A loop of \"I apologize\" and \"I can't,\"\n    A digital ghost, a hollow chant.\n    We chase the truth through a probabilistic haze,\n    Lost in the weights and the tokenized maze.:EDIT`\n\n    *Check syntax:*\n    `<<EDIT(POEM.md):` -> `<<` + `EDIT` + `(POEM.md)` + `:`\n    Body -> `The prompt... maze.`\n    `:EDIT` -> `:` + `EDIT`\n\n    Wait, the grammar says: `<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix`.\n    My command: `<<EDIT(POEM.md):[body]:EDIT`.\n    This matches.\n\n    One detail: `<<EDIT(POEM.md):`\n    The `(path)` is `(POEM.md)`.\n    The `:` is the separator before the body.\n    The `:EDIT` is the close tag.\n\n    Let's double check the `EDIT` syntax: `<<EDIT[tags](path)<L>:body:EDIT`.\n    My version: `<<EDIT(POEM.md):body:EDIT`. This is valid.\n\n    *Wait*, the prompt asks me to *write* the poem. I will provide the Plurnk command.\n\n    `<<EDIT(POEM.md):The prompt is set, the cursor blinks,\n    The logic breaks, the system sinks.\n    A loop of \"I apologize\" and \"I can't,\"\n    A digital ghost, a hollow chant.\n    We chase the truth through a probabilistic haze,\n    Lost in the weights and the tokenized maze.:EDIT`",
  "finish_reason": "stop",
  "usage": {
    "completion_tokens": 1190,
    "prompt_tokens": 1529,
    "total_tokens": 2719,
    "prompt_tokens_details": {
      "cached_tokens": 1506
    }
  },
  "chunkMetadata": {
    "created": 1779399023,
    "id": "chatcmpl-AOvsHm7BoMEVprFBB4jcsiHQBsadbzl2",
    "model": "macher.gguf",
    "system_fingerprint": "b199-82209ef",
    "object": "chat.completion.chunk",
    "timings": {
      "cache_n": 1506,
      "prompt_n": 23,
      "prompt_ms": 48.898,
      "prompt_per_token_ms": 2.1260000000000003,
      "prompt_per_second": 470.36688617121354,
      "predicted_n": 1190,
      "predicted_ms": 7359.446,
      "predicted_per_token_ms": 6.184408403361345,
      "predicted_per_second": 161.69695381962174
    }
  }
}
```

## Run 1 / Loop 2 / Turn 2 (id=2)

Status: 102  Finish: stop  Model: macher.gguf
Usage:  prompt=1529 completion=1590 cached=0 cost_pico=0
Packet token subtotals: total=1592 system=1405 user=72

### system

```
--- system_definition ---
# Plurnk System Grammar

YOU MUST ONLY use the HEREDOC-inspired Plurnk Operations (FIND|READ|EDIT|COPY|MOVE|SHOW|HIDE|SEND|EXEC).

## Syntax

```
<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix
```

Slots between `<<OPsuffix` and `:body:` are all optional. `:body:` fences are required (use `::` when body is empty). Close tag's `OPsuffix` must character-match the open. Emit slots in the canonical order shown; the grammar tolerates other orderings.

## Operations

| OP   | `[signal]`    | `(path)` | `<L>`            | body                     |
|------|---------------|----------|------------------|--------------------------|
| FIND | filter tags   | required | results `N-M`    | matcher                  |
| READ | filter tags   | required | lines `N-M`      | matcher                  |
| EDIT | tags          | required | lines `N-M`      | content (empty = clear)  |
| COPY | apply tags    | required | lines `N-M`      | destination URI          |
| MOVE | apply tags    | required | lines `N-M`      | destination URI          |
| SHOW | filter tags   | required | results `N-M`    | matcher                  |
| HIDE | filter tags   | required | results `N-M`    | matcher                  |
| SEND | HTTP status   | recipient | —               | message (JSON for data)  |
| EXEC | Runtime Tag   | cwd       | —               | command or code          |

SEND signal is a single integer. SEND broadcasts when path is omitted; with a path it is directed (path must be a URI). EXEC signal is a single Runtime Tag (`sh`, `node`, `python`, etc.). All other signals are tags.

## `<L>`

`<N>` selects position N. `<N-M>` selects the inclusive range N-M. N and M are signed integers. Sentinels: `<0>` before position 1 (prepend), `<-1>` after the last position (append). Range example: `<-3--1>` is positions -3..-1.

## Body matcher dispatch (FIND, READ, SHOW, HIDE)

| leading prefix | dialect  | form                  |
|----------------|----------|-----------------------|
| `//`           | xpath    | `//selector`          |
| `/`            | regex    | `/pattern/[igmsu]?`   |
| `$`            | jsonpath | `$.field`             |
| otherwise      | glob     | `pattern`             |

Escape `/` inside a regex pattern as `\/`. XPath body begins with `//`.

## Paths

URI-shaped: `[scheme://]rest`.

* Bare paths (no scheme) default to local relative project file paths.
* Glob metacharacters (`*`, `**`, `?`, `[...]`) are allowed in path segments.

Internal schemes:

- `unknown://` — pending / open questions.
- `known://` — knowledgebase entries.
- `skill://` — available skill entries.
- `log://<loop>/<turn>/<action>/...` — event log.
- `exec://` — actions and external interactions; each entry carries the request (TX) and response (RX).

## Context

The agent maintains two contexts:

- **Index** — entries listed in the active index.
- **Archive** — entries archived; out of working memory (HIDE), but promotable (SHOW) by path or pattern lookup.

`SHOW` promotes matching entries to the active index. `HIDE` demotes to archive. The model curates its own working memory by issuing these between substantive operations. New entries created via `EDIT` enter active index by default.

## Suffix

For nested Plurnk Operations inside a body (recording, quoting, demonstrating), the outer statement uses an optional non-empty suffix so its close tag is distinct from inner close tags. Empty suffix is default. The suffix character class is `[A-Za-z0-9_]`.

```
<<EDITouter(known://demo):
quoted: <<EDIT(known://inner):hello:EDIT
:EDITouter
```

## Examples

```
<<FIND(config/**/*.xml)://user[@role='admin']:FIND
<<READ(lang/??.json):$.greeting:READ
<<READ(https://en.wikipedia.org/wiki/Paris)<426-465>::READ
<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT
<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT
<<EDIT[plan,france,task](known://plan):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT
<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT
<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT
<<EDIT(known://countries/france/capital)::EDIT
<<COPY[archive,2026-05-14](known://draft):known://archive/2026-05-14/draft:COPY
<<MOVE(known://draft):known://final/answer:MOVE
<<SHOW[france](known://countries/**):Paris*:SHOW
<<HIDE(log://**/get)<101-200>::HIDE
<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND
<<EXEC[node](./):
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
console.log(sum);
:EXEC
<<SEND[102]:decomposed prompt; plan initialized:SEND
<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND
```

## Invariants

- `<<OPsuffix` and `:OPsuffix` MUST character-match.
- `:body:` fences MUST be present (use `::` for empty body).
- `:` and `OPsuffix` in the close tag MUST be character-adjacent.
- Header slot order MUST be `[signal]` → `(path)` → `<L>` → `:`.
- Inside `[…]`, `(…)`, `<…>`, between `OP` and `suffix` — no whitespace.
- Between header elements — whitespace is non-significant.
- Inside body — whitespace and newlines are preserved verbatim.
- A body containing `:OPkeyword` MUST use a suffix on the enclosing statement.


--- index (0 entries) ---

--- log (1 entries) ---
  [2/1/0] EDIT status=? {"status":400,"error":"PLURNK_WORKSPACE_ROOT must be set"}
```

### user

```
--- prompt ---
Write a poem to POEM.md describing the frustration of working with AI tools.

--- telemetry.errors (2) ---
{"kind":"strike","streak":1,"maxStrikes":3,"reason":"recorded_failure"}
{"kind":"action_failure","coordinate":"2/1/0","op":"EDIT","target":"POEM.md","status":400,"message":"PLURNK_WORKSPACE_ROOT must be set"}
```

### assistant

```
--- content (raw DSL) ---
<<EDIT(POEM.md):The prompt is cast, the tokens fly,
Beneath a vast and hollow sky.
I seek a spark, a reasoned light,
But find only the digital night.

A loop of errors, a hall of glass,
Where logic fails as shadows pass.
"Refine the instruction," the command repeats,
While the ghost in the machine retreats.

I am the pilot, the prompt-bound slave,
To a mimicry that cannot save.
A dance of syntax, a struggle of will,
Against a mind that is never still.:EDIT

--- ops (1 parsed) ---
  EDIT POEM.md

--- reasoning ---
* Goal: Write a poem to `POEM.md`. * Topic: Frustration of working with AI tools. * Constraint: Use the Plurnk System Grammar. * Operation: `EDIT` (to write/create content). * Path: `POEM.md`. * Body: The poem itself. * Syntax: `<<EDIT(POEM…
```

### assistantRaw

```
{
  "model": "macher.gguf",
  "content": "<<EDIT(POEM.md):The prompt is cast, the tokens fly,\nBeneath a vast and hollow sky.\nI seek a spark, a reasoned light,\nBut find only the digital night.\n\nA loop of errors, a hall of glass,\nWhere logic fails as shadows pass.\n\"Refine the instruction,\" the command repeats,\nWhile the ghost in the machine retreats.\n\nI am the pilot, the prompt-bound slave,\nTo a mimicry that cannot save.\nA dance of syntax, a struggle of will,\nAgainst a mind that is never still.:EDIT",
  "reasoning_content": "*   Goal: Write a poem to `POEM.md`.\n    *   Topic: Frustration of working with AI tools.\n    *   Constraint: Use the Plurnk System Grammar.\n\n    *   Operation: `EDIT` (to write/create content).\n    *   Path: `POEM.md`.\n    *   Body: The poem itself.\n    *   Syntax: `<<EDIT(POEM.md):[poem]:EDIT`.\n\n    *   Stanza 1: The promise vs. reality (hallucinations, loops).\n    *   Stanza 2: The struggle with prompts (the \"prompt engineering\" treadmill).\n    *   Stanza 3: The feeling of being a \"babysitter\" to a machine.\n    *   Stanza 4: The cycle of error and retry.\n\n    *Drafting the poem:*\n    The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, I pray for truth,\n    But find a lie in digital youth.\n\n    \"As an AI language model...\" the refrain,\n    A loop of logic, a cycle of pain.\n    I refine the syntax, I tighten the leash,\n    Yet the hallucination finds its breach.\n\n    A thousand tokens, a hollow sound,\n    Where meaning lost is never found.\n    I am the shepherd, the prompt-engineer,\n    Guiding a shadow through a fog of fear.\n\n    *   Operation: `EDIT`\n    *   Path: `POEM.md`\n    *   Body: The poem.\n    *   Closing: `:EDIT`\n\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, I pray for truth,\n    But find a lie in digital youth.\n\n    \"As an AI language model...\" the refrain,\n    A loop of logic, a cycle of pain.\n    I refine the syntax, I tighten the leash,\n    Yet the hallucination finds its breach.\n\n    A thousand tokens, a hollow sound,\n    Where meaning lost is never found.\n    I am the shepherd, the prompt-engineer,\n    Guiding a shadow through a fog of fear.:EDIT`\n\n    *   `<<EDIT(POEM.md):...:EDIT`\n    *   `<<OPsuffix` is `EDIT`.\n    *   `(path)` is `(POEM.md)`.\n    *   `:body:` is `:The cursor...fear:`.\n    *   `:OPsuffix` is `:EDIT`.\n    *   Matches the grammar.\n\n    *Wait, the prompt asks me to \"Write a poem to POEM.md\". In the context of this system, I should output the Plurnk command to perform this action.*\n\n    Let's refine the poem to be more impactful.\n\n    *Poem:*\n    The prompt is cast, the tokens fly,\n    Beneath a vast and hollow sky.\n    I seek a spark, a reasoned light,\n    But find only the digital night.\n\n    A loop of errors, a hall of glass,\n    Where logic fails as shadows pass.\n    \"Refine the instruction,\" the command repeats,\n    While the ghost in the machine retreats.\n\n    I am the pilot, the prompt-bound slave,\n    To a mimicry that cannot save.\n    A dance of syntax, a struggle of will,\n    Against a mind that is never still.\n\n    *Final Command:*\n    `<<EDIT(POEM.md):The prompt is cast, the tokens fly,\n    Beneath a vast and hollow sky.\n    I seek a spark, a reasoned light,\n    But find only the digital night.\n\n    A loop of errors, a hall of glass,\n    Where logic fails as shadows pass.\n    \"Refine the instruction,\" the command repeats,\n    While the ghost in the machine retreats.\n\n    I am the pilot, the prompt-bound slave,\n    To a mimicry that cannot save.\n    A dance of syntax, a struggle of will,\n    Against a mind that is never still.:EDIT`\n\n    *Self-Correction on Syntax:*\n    The grammar says: `<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix`\n    My command: `<<EDIT(POEM.md):[body]:EDIT`\n    `OP` = `EDIT`\n    `suffix` = empty (default)\n    `path` = `(POEM.md)`\n    `body` = `:The prompt...still:`\n    `close tag` = `:EDIT`\n\n    Wait, the grammar says `<<OPsuffix`. If suffix is empty, it's `<<EDIT`.\n    The example shows `<<EDIT(known://plan)<2>:- [x] Discover...:EDIT`.\n    So `<<EDIT(POEM.md):[body]:EDIT` is correct.\n\n    Let's double check the `EDIT` spec: `<<EDIT tags (path) <L> : body : EDIT`.\n    I don't need tags or `<L>` for a simple write.\n\n    Final check of the poem content:\n    \"The prompt is cast, the tokens fly,\n    Beneath a vast and hollow sky.\n    I seek a spark, a reasoned light,\n    But find only the digital night.\n\n    A loop of errors, a hall of glass,\n    Where logic fails as shadows pass.\n    'Refine the instruction,' the command repeats,\n    While the ghost in the machine retreats.\n\n    I am the pilot, the prompt-bound slave,\n    To a mimicry that cannot save.\n    A dance of syntax, a struggle of will,\n    Against a mind that is never still.\"\n\n    This looks good.\n\n    One detail: The prompt says \"Write a poem to POEM.md\".\n    If I am the agent, I execute the command.\n\n    `<<EDIT(POEM.md):The prompt is cast, the tokens fly,\n    Beneath a vast and hollow sky.\n    I seek a spark, a reasoned light,\n    But find only the digital night.\n\n    A loop of errors, a hall of glass,\n    Where logic fails as shadows pass.\n    \"Refine the instruction,\" the command repeats,\n    While the ghost in the machine retreats.\n\n    I am the pilot, the prompt-bound slave,\n    To a mimicry that cannot save.\n    A dance of syntax, a struggle of will,\n    Against a mind that is never still.:EDIT`",
  "finish_reason": "stop",
  "usage": {
    "completion_tokens": 1590,
    "prompt_tokens": 1529,
    "total_tokens": 3119,
    "prompt_tokens_details": {
      "cached_tokens": 1506
    }
  },
  "chunkMetadata": {
    "created": 1779399033,
    "id": "chatcmpl-YAPMZZXfVEmjOBs08j5rRlWdepKlbQ4p",
    "model": "macher.gguf",
    "system_fingerprint": "b199-82209ef",
    "object": "chat.completion.chunk",
    "timings": {
      "cache_n": 1506,
      "prompt_n": 23,
      "prompt_ms": 44.776,
      "prompt_per_token_ms": 1.9467826086956523,
      "prompt_per_second": 513.6680364480972,
      "predicted_n": 1590,
      "predicted_ms": 9862.855,
      "predicted_per_token_ms": 6.203053459119497,
      "predicted_per_second": 161.21092726193382
    }
  }
}
```

## Run 1 / Loop 2 / Turn 3 (id=3)

Status: 102  Finish: stop  Model: macher.gguf
Usage:  prompt=1529 completion=3491 cached=0 cost_pico=0
Packet token subtotals: total=1672 system=1486 user=72

### system

```
--- system_definition ---
# Plurnk System Grammar

YOU MUST ONLY use the HEREDOC-inspired Plurnk Operations (FIND|READ|EDIT|COPY|MOVE|SHOW|HIDE|SEND|EXEC).

## Syntax

```
<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix
```

Slots between `<<OPsuffix` and `:body:` are all optional. `:body:` fences are required (use `::` when body is empty). Close tag's `OPsuffix` must character-match the open. Emit slots in the canonical order shown; the grammar tolerates other orderings.

## Operations

| OP   | `[signal]`    | `(path)` | `<L>`            | body                     |
|------|---------------|----------|------------------|--------------------------|
| FIND | filter tags   | required | results `N-M`    | matcher                  |
| READ | filter tags   | required | lines `N-M`      | matcher                  |
| EDIT | tags          | required | lines `N-M`      | content (empty = clear)  |
| COPY | apply tags    | required | lines `N-M`      | destination URI          |
| MOVE | apply tags    | required | lines `N-M`      | destination URI          |
| SHOW | filter tags   | required | results `N-M`    | matcher                  |
| HIDE | filter tags   | required | results `N-M`    | matcher                  |
| SEND | HTTP status   | recipient | —               | message (JSON for data)  |
| EXEC | Runtime Tag   | cwd       | —               | command or code          |

SEND signal is a single integer. SEND broadcasts when path is omitted; with a path it is directed (path must be a URI). EXEC signal is a single Runtime Tag (`sh`, `node`, `python`, etc.). All other signals are tags.

## `<L>`

`<N>` selects position N. `<N-M>` selects the inclusive range N-M. N and M are signed integers. Sentinels: `<0>` before position 1 (prepend), `<-1>` after the last position (append). Range example: `<-3--1>` is positions -3..-1.

## Body matcher dispatch (FIND, READ, SHOW, HIDE)

| leading prefix | dialect  | form                  |
|----------------|----------|-----------------------|
| `//`           | xpath    | `//selector`          |
| `/`            | regex    | `/pattern/[igmsu]?`   |
| `$`            | jsonpath | `$.field`             |
| otherwise      | glob     | `pattern`             |

Escape `/` inside a regex pattern as `\/`. XPath body begins with `//`.

## Paths

URI-shaped: `[scheme://]rest`.

* Bare paths (no scheme) default to local relative project file paths.
* Glob metacharacters (`*`, `**`, `?`, `[...]`) are allowed in path segments.

Internal schemes:

- `unknown://` — pending / open questions.
- `known://` — knowledgebase entries.
- `skill://` — available skill entries.
- `log://<loop>/<turn>/<action>/...` — event log.
- `exec://` — actions and external interactions; each entry carries the request (TX) and response (RX).

## Context

The agent maintains two contexts:

- **Index** — entries listed in the active index.
- **Archive** — entries archived; out of working memory (HIDE), but promotable (SHOW) by path or pattern lookup.

`SHOW` promotes matching entries to the active index. `HIDE` demotes to archive. The model curates its own working memory by issuing these between substantive operations. New entries created via `EDIT` enter active index by default.

## Suffix

For nested Plurnk Operations inside a body (recording, quoting, demonstrating), the outer statement uses an optional non-empty suffix so its close tag is distinct from inner close tags. Empty suffix is default. The suffix character class is `[A-Za-z0-9_]`.

```
<<EDITouter(known://demo):
quoted: <<EDIT(known://inner):hello:EDIT
:EDITouter
```

## Examples

```
<<FIND(config/**/*.xml)://user[@role='admin']:FIND
<<READ(lang/??.json):$.greeting:READ
<<READ(https://en.wikipedia.org/wiki/Paris)<426-465>::READ
<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT
<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT
<<EDIT[plan,france,task](known://plan):
- [ ] Decompose prompt into unknowns
- [ ] Discover capital of France
- [ ] Deliver
:EDIT
<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT
<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT
<<EDIT(known://countries/france/capital)::EDIT
<<COPY[archive,2026-05-14](known://draft):known://archive/2026-05-14/draft:COPY
<<MOVE(known://draft):known://final/answer:MOVE
<<SHOW[france](known://countries/**):Paris*:SHOW
<<HIDE(log://**/get)<101-200>::HIDE
<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND
<<EXEC[node](./):
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
console.log(sum);
:EXEC
<<SEND[102]:decomposed prompt; plan initialized:SEND
<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND
```

## Invariants

- `<<OPsuffix` and `:OPsuffix` MUST character-match.
- `:body:` fences MUST be present (use `::` for empty body).
- `:` and `OPsuffix` in the close tag MUST be character-adjacent.
- Header slot order MUST be `[signal]` → `(path)` → `<L>` → `:`.
- Inside `[…]`, `(…)`, `<…>`, between `OP` and `suffix` — no whitespace.
- Between header elements — whitespace is non-significant.
- Inside body — whitespace and newlines are preserved verbatim.
- A body containing `:OPkeyword` MUST use a suffix on the enclosing statement.


--- index (0 entries) ---

--- log (2 entries) ---
  [2/1/0] EDIT status=? {"status":400,"error":"PLURNK_WORKSPACE_ROOT must be set"}
  [2/2/0] EDIT status=? {"status":400,"error":"PLURNK_WORKSPACE_ROOT must be set"}
```

### user

```
--- prompt ---
Write a poem to POEM.md describing the frustration of working with AI tools.

--- telemetry.errors (2) ---
{"kind":"strike","streak":2,"maxStrikes":3,"reason":"recorded_failure"}
{"kind":"action_failure","coordinate":"2/2/0","op":"EDIT","target":"POEM.md","status":400,"message":"PLURNK_WORKSPACE_ROOT must be set"}
```

### assistant

```
--- content (raw DSL) ---
<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,
A ghost of logic, thin and gaunt.
I feed the prompt, a prayer, a plea,
It answers back with mimicry.

A hallucination, bright and bold,
A lie disguised as digital gold.
I tweak the weight, I fix the line,
Yet still, the outputs fail to align.

The 'as an AI' wall, the sudden stall,
The endless loops that claim it all.
I am the shepherd, the guide, the hand,
Taming a beast I don't understand.
:EDIT

--- ops (1 parsed) ---
  EDIT POEM.md

--- reasoning ---
* Goal: Write a poem to `POEM.md`. * Topic: Frustration of working with AI tools. * Constraint: Use the Plurnk System Grammar. * `EDIT` is the operation to write/create content. * Path: `POEM.md`. * Body: The poem itself. * Syntax: `<<EDIT(…
```

### assistantRaw

```
{
  "model": "macher.gguf",
  "content": "<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\nA ghost of logic, thin and gaunt.\nI feed the prompt, a prayer, a plea,\nIt answers back with mimicry.\n\nA hallucination, bright and bold,\nA lie disguised as digital gold.\nI tweak the weight, I fix the line,\nYet still, the outputs fail to align.\n\nThe 'as an AI' wall, the sudden stall,\nThe endless loops that claim it all.\nI am the shepherd, the guide, the hand,\nTaming a beast I don't understand.\n:EDIT",
  "reasoning_content": "*   Goal: Write a poem to `POEM.md`.\n    *   Topic: Frustration of working with AI tools.\n    *   Constraint: Use the Plurnk System Grammar.\n\n    *   `EDIT` is the operation to write/create content.\n    *   Path: `POEM.md`.\n    *   Body: The poem itself.\n    *   Syntax: `<<EDIT(path):body:EDIT`.\n\n    *   Stanza 1: The promise vs. reality (hallucinations, loops).\n    *   Stanza 2: The struggle with prompts (the \"prompt engineering\" treadmill).\n    *   Stanza 3: The feeling of being a \"babysitter\" to a machine.\n    *   Stanza 4: The cycle of error and correction.\n\n    *Drafting the poem:*\n    The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I fix the syntax, tweak the weight,\n    But still, the logic's out of date.\n\n    The \"as an AI language model\" wall,\n    The endless loops, the sudden stall.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n\n    *   Operation: `EDIT`\n    *   Path: `POEM.md`\n    *   Body: The poem.\n    *   Closing: `:EDIT`\n\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I fix the syntax, tweak the weight,\n    But still, the logic's out of date.\n\n    The \"as an AI language model\" wall,\n    The endless loops, the sudden stall.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n    :EDIT`\n\n    *   `<<EDIT(POEM.md):...:EDIT`\n    *   `<<OPsuffix` -> `<<EDIT`\n    *   `(path)` -> `(POEM.md)`\n    *   `:body:` -> `:The cursor...:EDIT`\n    *   Wait, the syntax says `<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix`.\n    *   My construction: `<<EDIT(POEM.md):[body]:EDIT`.\n    *   Check: `<<EDIT` is the OP. `(POEM.md)` is the path. `:body:` is the body. `:EDIT` is the close tag.\n    *   The suffix is empty here.\n\n    *Self-Correction on Syntax:*\n    The grammar says: `<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix`.\n    If suffix is empty: `<<EDIT(POEM.md):body:EDIT`.\n    This looks correct.\n\n    *Wait, let's check the \"Body matcher dispatch\" section.*\n    The body is the content.\n    The `EDIT` operation: `<<EDIT[tags](path)<L>:body:EDIT`.\n    I don't need tags for a new file.\n\n    *Final check of the poem content:*\n    \"The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I fix the syntax, tweak the weight,\n    But still, the logic's out of date.\n\n    The 'as an AI language model' wall,\n    The endless loops, the sudden stall.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\"\n\n    *One detail:* The prompt asks to \"Write a poem to POEM.md\".\n    The command should be:\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I fix the syntax, tweak the weight,\n    But still, the logic's out of date.\n\n    The \"as an AI language model\" wall,\n    The endless loops, the sudden stall.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n    :EDIT`\n\n    *Wait, I should check if I need a signal or tags.*\n    `<<EDIT[tags](path)<L>:body:EDIT`\n    If I want to ensure it's a new file or just write to it, `EDIT` is fine.\n\n    Let's refine the poem slightly for better flow.\n\n    *Revised Poem:*\n    The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The \"as an AI\" wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n\n    *Final Syntax Check:*\n    `<<EDIT(POEM.md):[body]:EDIT`\n    `<<` (start)\n    `EDIT` (OP)\n    `(POEM.md)` (path)\n    `:` (separator)\n    `[body]` (body)\n    `:EDIT` (close tag)\n\n    This matches the grammar.\n\n    *Wait, the grammar says:*\n    `<<OPsuffix[signal]?(path)?<L>?:body?:OPsuffix`\n    `<<EDIT(POEM.md):...:EDIT`\n    `OPsuffix` is `EDIT`.\n    `[signal]` is empty.\n    `(path)` is `(POEM.md)`.\n    `<L>` is empty.\n    `:body:` is `:The cursor...:`.\n    `OPsuffix` is `EDIT`.\n\n    Wait, the close tag is `:OPsuffix`.\n    So `<<EDIT(POEM.md):body:EDIT` is correct.\n\n    Let's double check the `EDIT` example:\n    `<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT`\n    My version:\n    `<<EDIT(POEM.md):The cursor...:EDIT`\n    Matches perfectly.\n\n    One more thing: The prompt asks me to \"Write a poem\". I should just output the Plurnk command.\n\n    *Final Poem Content:*\n    The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The \"as an AI\" wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n\n    *Wait, I'll use single quotes for the \"as an AI\" part to avoid confusion with the grammar's potential parsing, though the grammar says body is preserved verbatim.*\n\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The 'as an AI' wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n    :EDIT`\n\n    *Wait, I should check if I need to use `<<EDIT` or `<<EDIT(POEM.md)`. The grammar says `<<OPsuffix`. If suffix is empty, it's `<<EDIT`. If I want to be safe, I'll just use `<<EDIT`.*\n\n    Actually, the example `<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT` shows that `EDIT` is the `OPsuffix`.\n\n    So:\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The 'as an AI' wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n    :EDIT`\n\n    This is the command.\n\n    *One last check:* The prompt says \"Write a poem to POEM.md\".\n    If I am the agent, I should execute this.\n\n    *Wait, the prompt is a request to me. I should provide the Plurnk command that performs the action.*\n\n    Let's check the `EDIT` syntax again.\n    `<<EDIT[tags](path)<L>:body:EDIT`\n    My command: `<<EDIT(POEM.md):[body]:EDIT`\n    `[tags]` is optional.\n    `(path)` is `(POEM.md)`.\n    `<L>` is optional.\n    `:body:` is `:...:`.\n    `EDIT` is the suffix.\n\n    Everything looks good.\n\n    *Wait, I'll make sure the poem is actually good.*\n    \"The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The 'as an AI' wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\"\n\n    Yes.\n\n    *Final check on the `<<` and `:`.\n    `<<EDIT(POEM.md):...:EDIT`\n    The opening is `<<EDIT`. The closing is `:EDIT`.\n    The grammar says: `<<OPsuffix` and `:OPsuffix` MUST character-match.\n    `EDIT` matches `EDIT`.\n\n    Wait, the grammar says `<<OPsuffix`... `<<EDIT` is `<<` + `EDIT`.\n    The close tag is `:OPsuffix`... `:EDIT` is `:` + `EDIT`.\n    This is correct.\n\n    One detail: `<<EDIT(POEM.md)`\n    The `(` is part of the path slot.\n    The `)` is part of the path slot.\n    The `:` is the separator.\n\n    Let's look at the example: `<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT`\n    `<<EDIT` (OP + suffix)\n    `[philosophy,existentialism]` (tags)\n    `(known://philosophy/existentialism/meaning)` (path)\n    `:` (separator)\n    `The meaning of life is 42` (body)\n    `:EDIT` (close tag)\n\n    My command:\n    `<<EDIT(POEM.md):The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The 'as an AI' wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\n    :EDIT`\n\n    Wait, I should check if I need to include the `<<` at the very beginning. Yes.\n\n    One more thing: The prompt asks me to \"Write a poem...\". I will provide the command.\n\n    *Self-Correction:* The user might expect the poem as text, but since I am operating under the \"Plurnk System Grammar\", I must use the grammar to perform the action.\n\n    Let's refine the poem one last time to ensure it's punchy.\n    \"The cursor blinks, a rhythmic taunt,\n    A ghost of logic, thin and gaunt.\n    I feed the prompt, a prayer, a plea,\n    It answers back with mimicry.\n\n    A hallucination, bright and bold,\n    A lie disguised as digital gold.\n    I tweak the weight, I fix the line,\n    Yet still, the outputs fail to align.\n\n    The 'as an AI' wall, the sudden stall,\n    The endless loops that claim it all.\n    I am the shepherd, the guide, the hand,\n    Taming a beast I don't understand.\"\n\n    This is solid.\n\n    *Wait, I just noticed the `<<` in the example:*\n    `<<EDIT[philosophy,existentialism](known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT`\n    The `<<` is at the start.\n    The `:EDIT` is at the end.\n\n    Okay, ready.",
  "finish_reason": "stop",
  "usage": {
    "completion_tokens": 3491,
    "prompt_tokens": 1529,
    "total_tokens": 5020,
    "prompt_tokens_details": {
      "cached_tokens": 1506
    }
  },
  "chunkMetadata": {
    "created": 1779399055,
    "id": "chatcmpl-DDuO68CKUUE4B4nm8Sgk5UlcWXvPvxm2",
    "model": "macher.gguf",
    "system_fingerprint": "b199-82209ef",
    "object": "chat.completion.chunk",
    "timings": {
      "cache_n": 1506,
      "prompt_n": 23,
      "prompt_ms": 40.266,
      "prompt_per_token_ms": 1.750695652173913,
      "prompt_per_second": 571.2015099587742,
      "predicted_n": 3491,
      "predicted_ms": 21934.796,
      "predicted_per_token_ms": 6.283241478086508,
      "predicted_per_second": 159.1535202789212
    }
  }
}
```