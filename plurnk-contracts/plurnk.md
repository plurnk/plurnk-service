# Plurnk Session

plurnk.note({"text":<<<EOF
- YOU MUST ONLY submit a batch of tool calls for evaluation: `<server>.<tool>({}) // aside`.
- YOU SHOULD prefer `<<<EOF[a-zA-Z0-9]*` for complex and/or multi-line values.
- YOU SHOULD prefer hash anchors or pattern replacement with `plurnk.edit` to avoid stale targets.
- YOU SHOULD take at least one `plurnk.note` each turn to record your facts, conclusions, and plans.

The loop will continue (or `plurnk.wait`) until all Open Work is settled or delivered (`plurnk.done`).
EOF}) // fact
