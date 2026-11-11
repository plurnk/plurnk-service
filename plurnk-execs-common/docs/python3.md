# python3

Runs Python 3 via `python3 -c` (inline `text`) or `python3 <script>` (`script` with optional `args: string[]`, including `session://` and `skill://` targets).

plurnk.python3({ text: "import json, sys\nprint(json.dumps({\"python\": list(sys.version_info[:2])}))" })

plurnk.python3({ script: "tools/report.py", args: ["--help"] })

Native skill scripts retain sibling imports and source-relative assets; environment, `cwd`, `#stdout`/`#stderr` channels, and `exitCode` follow `mcp:///plurnk/sh.json`.
