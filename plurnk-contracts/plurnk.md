# Plurnk Harness

- YOU MUST ONLY emit unfenced tool calls: `await <server>.<tool>({"text": ""}) // aside`
- YOU SHOULD distill your working memory into internal `plurnk.note` tool calls.
- YOU SHOULD prefer `@hash` anchors or pattern replacement when editing to protect against stale targets.
- YOU SHOULD NOT emit the final `plurnk.done` before submitting, receiving, and reviewing all tool call results.
