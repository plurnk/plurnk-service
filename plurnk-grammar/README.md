# Plurnk Grammar

The Pattern-Lookup Unknowns Resolution Node Kit (plurnk) possesses an ANTLR4-dialect EBNF state machine grammar.

## Plurnk Machine

The Plurnk Machine consists of an Active Context that is visible to the model and
an unlimited Extended Context that the model can exploit to optimize the
relevance and efficiency of its Active Context. Plurnk's HEREDOC-style grammar
requires the model to own, remember, and optimize for its context token budget.

## Plurnk Syntax

<<OPsuffix[signal](path)<L>:body:OPsuffix

OP: Operation Code (FIND|READ|EDIT|COPY|MOVE|SHOW|HIDE|SEND|EXEC)
suffix: Optional suffix; reserved for nesting and `:OPkeyword` escape (see SPEC.md §8)
signal: Optional CSV; OP-specific interpretation (see SPEC.md §4)
path: URI-style address; bare paths default to `file://`
L: Optional line marker; `<N>` for a single position or `<N-M>` for an inclusive range. N and M are signed integers.
:body: The body is fenced by `:` on the header side and `:OPsuffix` on the close. Body is fully opaque between the colons.
body: OP-specific meaning (see SPEC.md §4): content, destination, payload, command, or pattern matcher

* Bulk Pattern Matching: Use glob, regex, jsonpath, or xpath syntax

## Plurnk Operation Codes

FIND: List matching paths
READ: Retrieve the contents of a given path
EDIT: Write content (empty body clears the entry)
COPY: Copy from pathSrc to pathDest
MOVE: Move from pathSrc to pathDest
SHOW: Add path from Extended Context to Active Context
HIDE: Remove path from Active Context to Extended Context
SEND: Send a message (body)
EXEC: Execute a command or code snippet in a runtime (shell by default; language selectable via [signal])

## Plurnk Examples

1. List all xml files containing the admin user role.
	<<FIND(config/**/*.xml)://user[@role='admin']:FIND

2. Read hello in every language
	<<READ(lang/??.json):$.greeting:READ

3. Write a known entry to active context
	<<EDIT(known://philosophy/existentialism/meaning):The meaning of life is 42:EDIT

4. Read an entry in full
	<<READ(https://www.britannica.com/biography/Donald-Rumsfeld)::READ

5. Read lines 426–465 of a long article
	<<READ(https://en.wikipedia.org/wiki/Donald_Rumsfeld)<426-465>::READ

6. Create an unknown entry with tags
	<<EDIT[france,geography](unknown://countries/france/capital):What is the capital of France?:EDIT

7. Create a multi-line plan
	<<EDIT(known://plan):
	- [ ] Decompose prompt into unknowns
	- [ ] Discover capital of France
	- [ ] Deliver
	:EDIT

8. Mark a plan step complete (single-line replace)
	<<EDIT(known://plan)<2>:- [x] Discover capital of France:EDIT

9. Replace a range of lines
	<<EDIT(known://countries/france/capital)<4-5>:
	The capital of France is Paris, on the river Seine.
	Paris has been the continuous capital of France since 987 CE.
	:EDIT

10. Append content to an existing entry
	<<EDIT(known://countries/france/capital)<-1>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

11. Prepend content to an existing entry
	<<EDIT(known://countries/france/capital)<0>:[Wikipedia: Paris](https://en.wikipedia.org/wiki/Paris):EDIT

12. Clear entry contents (empty body between two colons)
	<<EDIT(known://countries/france/capital)::EDIT

13. Archive every distilled fetch log
	<<HIDE(log://1/*/*/get)::HIDE

14. Restore archived entries by tag filter
	<<SHOW[france](known://**)::SHOW

15. Rename a draft entry
	<<MOVE(known://draft):known://final/answer:MOVE

16. Run a shell command in the project root
	<<EXEC(./):node --test:EXEC

17. Continue the loop
	<<SEND[102]:decomposed prompt; plan initialized:SEND

18. Deliver the final answer
	<<SEND[200]:Paris:SEND

19. Search logs for timeout errors (case-insensitive regex body)
	<<FIND(log://**/error):/timeout|deadline exceeded/i:FIND

20. Find entries whose content begins with "Paris" (glob body)
	<<FIND(known://countries/**):Paris*:FIND

21. List the first 20 entries under a broad path (result-set pagination)
	<<FIND(known://**)<1-20>::FIND

22. Read the first five lines of a local file (bare path → file://)
	<<READ(./README.md)<1-5>::READ

23. Copy a draft entry to a dated archive location
	<<COPY(known://draft):known://archive/2026-05-14/draft:COPY

24. Run an inline node script
	<<EXEC[node](./):
	const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
	console.log(sum);
	:EXEC

25. Restore entries tagged france that contain "Paris" (combined filters)
	<<SHOW[france](known://countries/**):Paris*:SHOW

26. Archive the second hundred of stale fetch logs (pagination)
	<<HIDE(log://**/get)<101-200>::HIDE

27. Deliver a structured answer (JSON body)
	<<SEND[200]:{"answer":"Paris","confidence":0.95}:SEND

28. Report a client error (JSON body the model can traverse with jsonpath)
	<<SEND[400]:{"reason":"unrecognized OP","got":"FOOBAR","expected":["FIND","READ","EDIT","COPY","MOVE","SHOW","HIDE","SEND","EXEC"]}:SEND

29. Report a server error with explicit recipient
	<<SEND[503](log://errors):{"reason":"git unavailable","command":"git status"}:SEND

30. Direct an informational message at a named agent
	<<SEND[102](agent://supervisor):decomposition complete; awaiting clearance:SEND

31. Quote a plurnk operation inside another (nesting via suffix discipline)
	<<EDITouter(known://demo):
	The following is a quoted plurnk operation, preserved verbatim:
	<<EDIT(known://inner):hello world:EDIT
	:EDITouter
