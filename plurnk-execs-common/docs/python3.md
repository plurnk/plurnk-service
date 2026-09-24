# python3

The body is Python code, run with `python3 -c`. A script target instead runs
that file and receives the body as stdin; `[{"args": [...]}]` passes literal
arguments and `[{"cwd": "<directory>"}]` selects the working directory, as for
every interpreter (`sh.md`).

```python3 <!-- the body is the program -->
import json, sys
print(json.dumps({"python": list(sys.version_info[:2])}))
```

```python3 (tools/report.py) [{"args": ["--help"]}]
```

Native skill files retain their sibling imports and source-relative assets.
Live input (`[{"stdin": "open"}]`, SEND, `[{"eof": true}]`) is as `node.md`
shows.
