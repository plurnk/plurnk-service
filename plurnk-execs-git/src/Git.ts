import { CommandSyntaxError, SubprocessExecutor, tokenizeArgv } from "@plurnk/plurnk-execs";
import type { ExecArgs, ExecResult, SpawnArgs } from "@plurnk/plurnk-execs";

// Git exports these repository-local variables to hooks. If plurnk is invoked
// from one of those hooks, they override cwd and `-C` in a nested Git process.
// Clear only repository identity; normal user config, credentials, SSH, and
// tracing remain part of the environment handed to the executor.
const REPOSITORY_ENV = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
]);

const repositoryEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries(env).filter(([key]) =>
        !REPOSITORY_ENV.has(key) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)));

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

    // Two shapes are unambiguous before anything spawns and cost a model turn each when git's own
    // stderr is all it hears: a body that starts with `git` (the executor's name repeated) and a
    // body carrying shell syntax (`&&`, `;`, `|`, redirections, substitutions) that git would receive
    // as literal arguments. Name the form; never reinterpret the body (#395).
    static #SHELL_SYNTAX = /(?:^|\s)(?:&&|\|\||;|\||>{1,2}|<)(?:\s|$)|;\s|\$\(|`/;

    protected override spawnArgs(runtime: string, command: string, target: string | null): SpawnArgs {
        if (runtime !== "git") throw new Error(`plurnk-execs-git received unclaimed runtime tag '${runtime}'`);
        const shell = Git.#SHELL_SYNTAX.exec(command);
        if (shell !== null) {
            throw new CommandSyntaxError(
                `the body carries shell syntax (\`${shell[0].trim()}\`)`,
                "`[git]` runs one git command as argv; a shell command line belongs in a bare `## EXEC0 (.)` body.",
            );
        }
        const argv = tokenizeArgv(command);
        if (argv[0] === "git") {
            throw new CommandSyntaxError(
                "the body starts with `git`",
                "`[git]` is the git executor; the body is git's arguments — write `remote -v`, not `git remote -v`.",
            );
        }
        return {
            cmd: "git",
            args: [...(target === null ? [] : ["-C", target]), ...argv],
            useShell: false,
        };
    }

    override run(args: ExecArgs): Promise<ExecResult> {
        return super.run({ ...args, env: repositoryEnv(args.env) });
    }
}
