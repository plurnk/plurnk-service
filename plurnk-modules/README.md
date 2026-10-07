# @plurnk/plurnk-modules

The contract a [Plurnk](https://github.com/plurnk/plurnk-service) daemon module codes against:
the lifecycle it implements and the base setup seam it receives. It holds types only and depends
on `@plurnk/plurnk-contracts` alone.

## Use

Declare the package as a peer dependency, then type your module by the slices it uses:

```ts
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { DaemonModule, FunctionalitySeam, ModuleSetupSeam } from "@plurnk/plurnk-modules";

type SetupSeam = Pick<ModuleSetupSeam, "readWorkspaceEnvironment"> & FunctionalitySeam;
type StartSeam = Pick<ApplicationPort, "listWorkspaces">;

export default class Module implements DaemonModule<SetupSeam, StartSeam> {
    setup(seam: SetupSeam): void { /* register what recovery may demand */ }
    async start(seam: StartSeam): Promise<void> { /* open exterior ingress */ }
}
```

What a module contributes to another kind is typed by that kind's framework: scheme registration and
facets by `@plurnk/plurnk-schemes`, runtimes by `@plurnk/plurnk-execs`, and the installed plugin
set by `@plurnk/plurnk-agent-plugins`.

For read-only resource folders, `ResourceTreeRegistrationSeam` in
`@plurnk/plurnk-schemes` lets a module supply named trees of original bytes; the host
provides their entry projections, MIME handling, and ordinary READ/FIND behavior.
The [`skills module`](../plurnk-skills/SPEC.md) uses this seam without importing core.

[`SPEC.md`](SPEC.md) owns the contract.
