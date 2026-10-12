---
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-execs": minor
---

An executor's preparation declares whether its invocation registers an input
receiver (`ExecPreparation.input: "open"`; the subprocess and jq executors
declare it when launched with `[{"stdin": "open"}]`), and SEND to an execution
answers each state exactly: launched without input is refused at once naming
the launch form; queued for a slot is refused at once and retryable; a declared
receiver that has not opened yet is waited for within the input timeout, and
the execution settling first closes input. A receiver registered without the
declaration is the executor's defect and fails its run.
