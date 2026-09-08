# python3

The body is Python code, run with `python3 -c`. A script target instead runs
that file and receives the body as stdin. Script arguments and working directory
are optional header metadata:

```python3 <!-- the body is the program -->
import json, sys
print(json.dumps({"python": list(sys.version_info[:2])}))
```

```python3 (tools/report.py) {args=["--help"]}```

Each argument is a literal string, without shell expansion. `{cwd=<directory>}`
selects the working directory; otherwise it remains the workspace root. The
same options apply to local and `worker://` script targets. Native skill files
retain their sibling imports and source-relative assets.
