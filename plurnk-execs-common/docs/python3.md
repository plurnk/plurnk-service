# python3

The `code` is Python code, run with `python3 -c`. Setting `cwd` selects the
working directory for that inline code. A `script` instead runs that file and
passes `args` as its arguments, as for every interpreter (`mcp:///plurnk/sh.json`).

await plurnk.python3({ code: "import json, sys\nprint(json.dumps({\"python\": list(sys.version_info[:2])}))" }); // the code is the program

await plurnk.python3({ script: "tools/report.py", args: ["--help"] });

Native skill files retain their sibling imports and source-relative assets.
