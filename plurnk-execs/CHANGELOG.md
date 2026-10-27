# @plurnk/plurnk-execs

## 4.0.3

### Patch Changes

- 2b882f9: Surface required multi-value `enum` unions, one-level structured object/array
  shapes, and bounded optional property signatures (`name?: type`) in tool
  invocation asides and blank-invocation recovery fences, include the tool's
  working invocation fence in `invalid-tool-arguments` and `tool-reported-error`
  recovery, hold model Functionality mutations at the workspace boundary across
  `authorization-required` sign-in, and conclude loops when a turn pairs a reply
  `SEND` with `WAIT` and no live work remains ({§executor-input-schema-preview},
  {§executor-blank-invocation}, {§problems-mcp}, {§functionality-model-projection},
  {§oauth-continuation}, {§loop-completion}) (#1228).

## 4.0.2

### Patch Changes

- Updated dependencies [cfa2be9]
- Updated dependencies [ff99f76]
- Updated dependencies [a8200fb]
- Updated dependencies [65da58e]
- Updated dependencies [d2dcf47]
- Updated dependencies [d679cc5]
- Updated dependencies [25aadcf]
- Updated dependencies [cc3e9cb]
- Updated dependencies [1f136f9]
- Updated dependencies [f7e3b0e]
- Updated dependencies [558c0db]
- Updated dependencies [0cee49c]
- Updated dependencies [878d630]
- Updated dependencies [c3922c2]
- Updated dependencies [dd52a9b]
- Updated dependencies [50fbe81]
- Updated dependencies [4e4cb32]
- Updated dependencies [22ec9ca]
- Updated dependencies [06d4a8d]
- Updated dependencies [39f234e]
- Updated dependencies [19df83f]
- Updated dependencies [de4fc63]
- Updated dependencies [de9ce8f]
- Updated dependencies [f3cd7de]
- Updated dependencies [4a048a8]
- Updated dependencies [2e5b2c1]
  - @plurnk/plurnk-contracts@6.0.0
  - @plurnk/plurnk-schemes@3.3.0

## 4.0.1

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0
  - @plurnk/plurnk-parser@4.2.0

## 4.0.0

- **Breaking:** shell execution uses an absolute executable `SHELL`, falling
  back to `/bin/sh`, rather than promising POSIX syntax regardless of the
  environment. The exported `Shell` resolver is shared by execution and
  capability advertising, which names the resolved program/version/path.
- Account-resolution failures retain the host lookup's cause instead of
  misreporting every failure as an absent account.
- Uses contracts/parser 4.0.

## 3.2.0

### Minor Changes

- d99a836: An executor's preparation declares whether its invocation registers an input
  receiver (`ExecPreparation.input: "open"`; the subprocess and jq executors
  declare it when launched with `[{"stdin": "open"}]`), and SEND to an execution
  answers each state exactly: launched without input is refused at once naming
  the launch form; queued for a slot is refused at once and retryable; a declared
  receiver that has not opened yet is waited for within the input timeout, and
  the execution settling first closes input. A receiver registered without the
  declaration is the executor's defect and fails its run.

### Patch Changes

- Updated dependencies [3e3e2f4]
- Updated dependencies [157cf8f]
- Updated dependencies [a8df72c]
  - @plurnk/plurnk-schemes@3.2.0
  - @plurnk/plurnk-contracts@3.3.0

## 3.1.1

### Patch Changes

- 7163937: Document existing failure codes omitted from the owning specifications. Runtime
  behavior and failure identities are unchanged.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.1.0

### Minor Changes

- 143eb55: Treat a command's exit code as its answer: a subprocess that exits resolves
  200 with its `exitCode`, zero or not, with no Problem, so a failing test run or
  a `grep` that matched nothing no longer appears in Errors. A process ended by
  a signal nobody sent it is a `terminated-by-signal` failure.
  
  Report a failed execution once: its status and Problem ride one conclusion
  row, and its other channel rows are plain reads. A stream stopped by its
  holder's own KILL concludes 200 instead of a 499 cancellation; a cancellation
  the holder did not ask for keeps its 499. A tool named as a shell command is
  core's `404 program-is-a-tool` receipt.

### Patch Changes

- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [9e0a3b2]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
- Updated dependencies [7a678da]
- Updated dependencies [9f8e27b]
  - @plurnk/plurnk-contracts@3.1.0
  - @plurnk/plurnk-schemes@3.1.0
  - @plurnk/plurnk-meta@2.1.0

## 3.0.0

### Major Changes

- 8d9fb11: `ExecInfo.attribution` is removed; discovery's `packageAttributions` carries
  every package's tags.

### Patch Changes

- 06960fc: Diagnostics across the stack say what happened, never why. A refusal names what
  was read, what was done with it and where, and recovers with the construct's
  working form; rebuilt scopes, suggested operations, presumed causes and
  migration hints for retired forms are gone.
- f1bbc46: Offer the native `question` tool only to a worker whose owner would receive
  it: an interactive owner that declares the tool. Other workers do not see it
  at turn 0 or in the reserved reference set, and a call is refused with a
  recovery saying nobody is present to answer. The tool is on by default;
  `PLURNK_EXECS_QUESTION=0` remains the operator's switch to remove it.
  Teaching now says SEND carries progress updates and WAIT yields to children
  and streams, without changing either operation's behavior.
- 503ea87: A `PLURNK_*` key the operator's configuration file sets and no installed package
  declares is named at startup and by `config check`; nothing is refused.
  Each package panel declares the key families it reads by computed name, such as
  `# PLURNK_MCP_<alias>=<definition>`.
- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [06960fc]
- Updated dependencies [c053b24]
- Updated dependencies [69f3ffe]
- Updated dependencies [8d9fb11]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1
  - @plurnk/plurnk-schemes@3.0.0
  - @plurnk/plurnk-parser@3.0.1

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-meta@2.0.0
  - @plurnk/plurnk-contracts@2.0.0
  - @plurnk/plurnk-parser@2.0.0
  - @plurnk/plurnk-schemes@2.0.0
