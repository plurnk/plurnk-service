# js

Runs JavaScript via `node -e` (inline `text`) or `node <script>` (`script` with optional `args: string[]`, including `session://` and `skill://` targets).

plurnk.js({ text: "const os = require(\"node:os\");\nconsole.log(JSON.stringify({ platform: os.platform(), cpus: os.cpus().length }));" })

plurnk.js({ script: "tool.js", args: ["--flag"] })

- Relative `import` / `require` resolves from the script; relative filesystem paths resolve from `cwd` (project root by default).
- Environment, `cwd`, `#stdout`/`#stderr` channels, and `exitCode` follow `mcp:///plurnk/sh.json`.
