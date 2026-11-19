# Common subprocess executors

## §execs-common-subprocess Floor runtimes, spawn recipes, and subprocess lifecycle

`Common` extends `SubprocessExecutor` ({§executor-subprocess}, {§executor-contract}) and declares `RUNTIME_TAGS` (`sh`, `js`, `python3`) via `plurnk.runtimesModule: "./runtimes"` ({§executor-discovery}, {§executor-policy}):

| Runtime | Glyph | Inline spawn (`target: null`) | Script spawn (`target !== null`) | `probe()` availability ({§executor-results}) |
| --- | --- | --- | --- | --- |
| `sh` | `🐚` | `[Shell.current().path, ["-c", body]]` (`useShell: false`) | `[Shell.current().path, [target, ...tokenizeArgv(body)]]` | `command -v <shell>` under `SpawnAccounts.options()` ({§executor-policy}) |
| `js` | `⬢` | `["node", ["-e", body]]` (`useShell: false`) | `["node", [target, ...tokenizeArgv(body)]]` | Always available (`detail: process.version`, no `PATH` probe) |
| `python3` | `🐍` | `["python3", ["-c", body]]` (`useShell: false`) | `["python3", [target, ...tokenizeArgv(body)]]` | `command -v python3` under `SpawnAccounts.options()` |

| Aspect | Contract |
| --- | --- |
| Effect & channels | Every tag classifies `effect()` as `"host"` and streams UTF-8 output to `stdout` (default) and `stderr` (`text/stream`, {§executor-contract}). |
| Script targets | The interpreter reads `target` directly and passes `tokenizeArgv(body)` as `argv` without consulting or mutating executable permissions (`+x`); unclaimed runtime tags throw. |
| Child environment & `cwd` | Inherits `SubprocessExecutor` POSIX process-group spawn, `cwd`/`env` composition (including `NODE_OPTIONS` permission flags and `PLURNK_EXECS_SPAWN_USER`), `PLURNK_ENV` scratch-file environment capture, and `AbortSignal` process-group cancellation ({§executor-subprocess}). |
