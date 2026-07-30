import { SubprocessExecutor, tokenizeArgv } from "@plurnk/plurnk-execs";
import type { SpawnArgs } from "@plurnk/plurnk-execs";

// Native Git executor. `git` means the installed Git CLI with its normal argv
// syntax; the command is tokenized but never interpreted by a shell. A target
// names the repo directory and maps to Git's standard `-C` option.
//
// Every invocation remains host-effecting and proposal-gated through the
// inherited executor contract. Git may invoke repository hooks, aliases,
// credential helpers, or network operations; deployments that do not grant
// those capabilities disable the runtime instead of receiving a substitute
// implementation under the same name.
export default class Git extends SubprocessExecutor {
    protected override get binary(): string {
        return "git";
    }

    protected override spawnArgs(runtime: string, command: string, target: string | null): SpawnArgs {
        if (runtime !== "git") throw new Error(`plurnk-execs-git received unclaimed runtime tag '${runtime}'`);
        return {
            cmd: "git",
            args: [...(target === null ? [] : ["-C", target]), ...tokenizeArgv(command)],
            useShell: false,
        };
    }
}
