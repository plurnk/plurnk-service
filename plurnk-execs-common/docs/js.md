# js

A JavaScript snippet, run via `node -e`. Node is the daemon's own runtime, so it
is always available (no PATH probe).

await plurnk.js({ code: "const os = require(\"node:os\");\nconsole.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }));" }); // the code is the snippet

`await plurnk.js({ script: "tool.js", args: ["--flag"] });` runs that JavaScript file and passes `args` as its arguments,
also for `session://` and `skill://` targets.
Relative imports resolve from the script; ordinary relative filesystem paths
resolve from the working directory. Environment, working directory, channels,
output on completion, and exit status are every subprocess executor's,
as `mcp:///plurnk/sh.json` states. Stdout is text, so structured output is serialized
(`console.log(JSON.stringify(value))`); a thrown error exits nonzero with its
stack on stderr.
