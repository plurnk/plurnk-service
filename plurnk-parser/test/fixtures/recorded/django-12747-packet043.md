```NOTE
tester4's streams show it stashed and popped changes mid-run, and its "1 error" report lacks verbatim details. I'll get a clean, verbatim failure report from a fresh worker.
```

```WORK (worker://verifier) <!-- clean verification with verbatim output -->
Run from the repository root, read-only (do NOT edit files, do NOT use git stash):
1. python tests/runtests.py delete --parallel 1 -v 1 2>&1 | tail -n 60
2. python tests/runtests.py proxy_models --parallel 1 2>&1 | tail -n 5
Paste the tail output of each run verbatim, including any FAILED/ERROR blocks and tracebacks.
```

```WAIT
```

## Log

### log:///1/17/1/SEND · 111
{"lines":3,"resource":"message://c95555b7/31fa4a0e","source":"worker://verifier","status":200}
1:Results:
2:
3:1. `python tests/runtests.py delete --parallel 1 -v 1 2>&1 | tail -n 60`:

### log:///1/17/2/READ → ops://verifier/1 · 556
{"origin":"_plurnk","range":"8 lines","source":"worker://verifier"}
1:Results:
2:
3:1. `python tests/runtests.py delete --parallel 1 -v 1 2>&1 | tail -n 60`:
4:   Ran 53 tests in 0.508s
5:   OK (skipped=1)
6:
7:2. `python tests/runtests.py proxy_models --parallel 1 2>&1 | tail -n 5`:
8:   Ran 29 tests in 0.212s
9:   OK

### log:///1/18/1/NOTE · 189
1:All green: delete suite 53 tests OK (skipped=1), proxy_models 29 OK. The earlier "1 error" from tester4 was an artifact of its stash/restore sequence racing with its own run. Final state is consistent.

## Delegation
{"workers":[],"streams":[]}```KILL (log:///1/[1-16]/*/{sh,READ,FIND}) <!-- trim bulky intermediate reads/streams -->
```Failed to deliver final response```

### log:///1/19/1/NOTE · 84
1:KILL with parameters is not a deliverable. All workers resolved, suites pass — deliver final response now.## Worker
{"path":"worker://c95555b7","parent":null,"loop":1,"turn":20}

## Delegation
{"workers":[],
"streams":[]}

## Git Status

> [!NOTE]
> branch `main` — 0 staged, 2 unstaged, 0 untracked
> unstaged: `django/db/models/deletion.py` · `tests/delete/tests.py`

## Context Curation
{"logTokensTotal":54361,"logTokensMax":2006817}

## Open Messages
[{"path":"message://c95555b7/ee76477b","origin":"user"}]All children resolved and verification is green (delete: 53 tests OK; proxy_models: 29 tests OK).

## Summary

**Issue:** `QuerySet.delete()` / `Model.delete()` returned `(0, {})` for empty cascading deletes but `(0, {'app.Model': 0})` for simple zero deletes — an inconsistent result format when nothing is deleted.

**Fix** (`django/db/models/deletion.py`, `Collector.delete()`): zero counts are no longer recorded in the deleted counter — both the fast-delete loop and the instance-delete loop now guard `deleted_counter[model._meta.label] += count` with `if count:`. Every zero-object delete now consistently returns `(0, {})`.

**Tests** (`tests/delete/tests.py`):
- `test_fast_delete_empty_no_update_can_self_select` now expects `(0, {})`.
- `test_queryset_delete_returns_num_rows` and `test_model_delete_returns_num_rows` only assert labels that actually had deletions (matching the upstream behavior for ticket #30551).```KILL
Fixed: Collector.delete() now skips zero counts in the deleted-counter (both fast-delete and instance-delete paths), so all zero-object deletes consistently return (0, {}) instead of sometimes (0, {'app.Model': 0}). Updated tests/delete/tests.py to the new contract (empty fast-delete expects (0, {}); num_rows tests assert only models with deletions). Verified: tests/runtests.py delete — 53 tests OK; proxy_models — 29 tests OK.
```