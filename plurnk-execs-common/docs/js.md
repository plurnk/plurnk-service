# js

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it
is always available (no PATH probe).

```js <!-- the body is the snippet -->
const os = require("node:os");
console.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }));
```

`js (tool.js)` runs that JavaScript file and passes the body as its arguments
(tokenized by shell quoting), also for `worker://` and `skill://` targets.
Relative imports resolve from the script; ordinary relative filesystem paths
resolve from the working directory. Environment, working directory, channels,
output on completion, exit status and lifetime are every subprocess executor's,
as `sh.md` states. Stdout is text, so structured output is serialized
(`console.log(JSON.stringify(value))`); a thrown error exits nonzero with its
stack on stderr.
