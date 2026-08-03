# plurnk-execs

Lean framework and contract for `@plurnk/plurnk-execs-*` runtime packages. Core
uses it to discover EXEC tags, admit calls, and stream each runtime's output
under its own tag-addressed scheme. The default service manifest, not this
framework, owns the standard installed leaf set ({§bundled-set}).

## Install

```sh
npm install @plurnk/plurnk-execs
```

Install executor leaves beside the framework to assemble a standalone host.
Any compatible third-party leaf remains discoverable without changing the
framework or service.

## Documentation

- [`SPEC.md`](./SPEC.md) — authoritative executor author and consumer contract.
- [plurnk-contracts](https://github.com/plurnk/plurnk-service/tree/main/plurnk-contracts) — EXEC AST and shared runtime-neutral contracts.
- [plurnk-schemes](https://github.com/plurnk/plurnk-service/tree/main/plurnk-schemes) — universal operation results and derived output-scheme contract.

## Write an executor

Publish a package under any scope with `plurnk.kind === "exec"`, one or more
runtime declarations, and a default-exported `BaseExecutor` subclass.

### Declare runtime tags

```json
{
  "plurnk": {
    "kind": "exec",
    "runtimes": [
      {
        "name": "cobol",
        "glyph": "🗄",
        "example": "<<EXEC[cobol]:DISPLAY 'HI'.:EXEC"
      }
    ]
  }
}
```

One package may claim several tags; the consumer instantiates and probes each
tag independently. A name uses lowercase URI-scheme syntax
`[a-z][a-z0-9+.-]*`; `only` is reserved by runtime policy. `example` is a
compact verbatim `plurnk` snippet, and every line in it must be a complete
`<<`-delimited operation. A `docs/<tag>.md` file supplies the full reference
material. See {§executor-runtime-declaration}.

### Implement the executor

| Runtime shape         | Base class           | Author-owned hooks                                                                      |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| Subprocess            | `SubprocessExecutor` | `spawnArgs()` and normally `binary`; stdout/stderr, abort, env, and exit are inherited. |
| Logical or in-process | `BaseExecutor`       | `channels`, `run()`, and optional `probe()` / `effect()`.                               |

`run()` receives only the inputs and consumer-owned sinks in
{§executor-sinks}. Return a universal result; expected failures carry RFC 9457
Problem Details and leave affected channels `errored`. Honor `signal`, write
only declared channels, and retain no state between runs.

`effect(target)` declares an admission fact. `host` is proposal-gated;
`read` and `pure` are automatically accepted. All three then use the same
background stream path—automatic acceptance is not a same-turn result. See
{§executor-effect}.

### Understand the target

The EXEC `(target)` slot is runtime-specific:

| Runtime family | Typical mapping                                                   |
| -------------- | ----------------------------------------------------------------- |
| Data           | Target is input; body is the program (`jq`, SQLite, WebAssembly). |
| Executable     | Target is the program; body is its stdin (shell, Python).         |

The consumer supplies both `cwd` and a resolved `target`; the leaf maps them
to its tool rather than reconstructing filesystem or scheme policy.

### Address output

The runtime tag is also the output scheme. A subprocess result is therefore
read at an address such as `sh:///1/2/3#stdout`, while a structured result may
be `sqlite:///1/2/3#results`. `exec://` is not an output address. Executors only
produce channels; the consumer owns storage and every later READ/FIND. See
{§executor-output-address}.

## Discovery and policy

`discover(options?)` scans scoped and unscoped packages under the nearest
`node_modules`, applies trust before executable hooks, applies boot policy, and
returns `{ registry, skipped, disabled }`. Tag collisions fail hard.

| Policy                              | Result                                        |
| ----------------------------------- | --------------------------------------------- |
| `PLURNK_EXECS_<TAG>=0` or `false`   | Tag is not registered.                        |
| `PLURNK_EXECS_ONLY=<list>`          | Only named tags remain; empty registers none. |
| `Policy.enabledAcross(tag, layers)` | Every layer must admit the tag.               |

Policy is subtractive; a downstream layer cannot restore a removed tag. See
{§executor-discovery}, {§executor-trust}, and {§executor-policy}.

## Exports

- `BaseExecutor`, `SubprocessExecutor`, and `SpawnArgs`.
- `discover`, `Policy`, `RuntimeTag`, and runtime discovery types.
- `ErrorDetail` and `PLURNK_EXECS_ERROR_DETAIL_LIMIT`.
- Executor arguments, channel, availability, and effect types.
- `Results`, result types, and runtime-neutral Notice types.

## Tests

`test:lint`, `test:unit`.
