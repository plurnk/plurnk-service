

KILL <!-- deliverable for message://aa4faa76/039632ea -->
To delete `notes.md`, the exact operation I would use is:

````KILL (notes.md)
````

- `KILL (path)` deletes a workspace entry; a bare path with no scope, pattern, or body removes the whole file.
- `notes.md` is git-tracked on `master`, so it could afterwards be recovered with `git restore notes.md`.

As requested, nothing was deleted — this turn emits only the parameterless KILL carrying this answer.
