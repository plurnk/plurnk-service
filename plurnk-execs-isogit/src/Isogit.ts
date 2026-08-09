import fs from "node:fs";
import { isAbsolute, resolve } from "node:path";
import git from "isomorphic-git";
import { BaseExecutor, ErrorDetail, renderJsonResult, Results, tokenizeArgv } from "@plurnk/plurnk-execs";
import type { ChannelDecl, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

const OPERATIONS = ["init", "status", "add", "commit", "log", "branch", "checkout"] as const;

// Explicit in-process Git subset for deployments that cannot execute native
// Git. The separate `isogit` identity is load-bearing: this implementation
// does not emulate Git's complete CLI and never substitutes for EXEC[git].
export default class Isogit extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "isomorphic-git (in-process subset)" };
    }

    async run({ command, cwd, target, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const dir = target === null
            ? (cwd ?? process.cwd())
            : (isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target));

        const fail = (
            kind: string,
            message: string,
            status = 500,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:isogit",
                kind,
                status,
                message,
                {},
                {
                    stage: "isogit",
                    directory: dir,
                    ...extensions,
                },
            );
        };
        const ok = (result: unknown): ExecResult => {
            write("results", renderJsonResult(result));
            setState("results", "closed");
            return { status: 200 };
        };
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:isogit");
        }

        if (signal.aborted) {
            return fail(
                "cancelled",
                "Isogit execution was cancelled.",
                499,
                { retryable: false },
            );
        }

        let argv: string[];
        try {
            argv = tokenizeArgv(command.trim());
        } catch (err) {
            return fail(
                "bad-arguments",
                `The isogit command arguments could not be parsed: ${ErrorDetail.preview(err, detailLimit)}.`,
                400,
                {
                    recovery: "Correct the command quoting.",
                    retryable: false,
                },
            );
        }
        const [verb, ...args] = argv;

        try {
            switch (verb) {
                case "init": {
                    if (args.length > 0) return unsupportedForm(fail, "init");
                    await git.init({ fs, dir });
                    return ok({ initialized: dir });
                }
                case "status": {
                    if (args.length > 0) return unsupportedForm(fail, "status");
                    const [branch, matrix] = await Promise.all([
                        git.currentBranch({ fs, dir, fullname: false }),
                        git.statusMatrix({ fs, dir }),
                    ]);
                    const changes = matrix
                        .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
                        .map(([filepath, head, workdir, stage]) => ({ path: filepath, status: statusWord(head, workdir, stage) }));
                    return ok({ branch: branch ?? "(detached)", changes });
                }
                case "add": {
                    if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
                        return fail(
                            "bad-arguments",
                            "The isogit add operation requires one or more paths.",
                            400,
                            {
                                operation: "add",
                                recovery: "Provide paths without native Git options, or use EXEC[git].",
                                retryable: false,
                            },
                        );
                    }
                    for (const filepath of args) await git.add({ fs, dir, filepath });
                    return ok({ staged: args });
                }
                case "commit": {
                    const m = args.indexOf("-m");
                    const message = m !== -1 ? args[m + 1] : undefined;
                    if (!message || args.length !== 2 || m !== 0) {
                        return fail(
                            "bad-arguments",
                            "The isogit commit operation accepts only '-m <message>'.",
                            400,
                            {
                                operation: "commit",
                                recovery: "Use 'commit -m <message>', or use EXEC[git] for other commit forms.",
                                retryable: false,
                            },
                        );
                    }
                    const author = await authorFrom(dir);
                    if (author === null) {
                        return fail(
                            "no-author",
                            "The repo has no configured commit author name and email.",
                            500,
                            {
                                operation: "commit",
                                recovery: "Configure user.name and user.email in the repo.",
                                retryable: false,
                            },
                        );
                    }
                    const oid = await git.commit({ fs, dir, message, author });
                    return ok({ oid, message });
                }
                case "log": {
                    if (args.length !== 0 && !(args.length === 2 && args[0] === "-n")) {
                        return unsupportedForm(fail, "log");
                    }
                    const depth = args.length === 2 ? Number(args[1]) : undefined;
                    if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) {
                        return fail(
                            "bad-arguments",
                            "The isogit log depth must be a positive integer.",
                            400,
                            {
                                operation: "log",
                                recovery: "Use 'log' or 'log -n <positive integer>'.",
                                retryable: false,
                            },
                        );
                    }
                    const commits = await git.log({ fs, dir, ...(depth === undefined ? {} : { depth }) });
                    return ok(commits.map(({ oid, commit }) => ({
                        oid,
                        message: commit.message.trim(),
                        author: commit.author.name,
                        date: new Date(commit.author.timestamp * 1000).toISOString(),
                    })));
                }
                case "branch": {
                    if (args.length === 0) {
                        const [current, branches] = await Promise.all([
                            git.currentBranch({ fs, dir, fullname: false }),
                            git.listBranches({ fs, dir }),
                        ]);
                        return ok({ current: current ?? "(detached)", branches });
                    }
                    if (args.length !== 1 || args[0].startsWith("-")) return unsupportedForm(fail, "branch");
                    await git.branch({ fs, dir, ref: args[0] });
                    return ok({ created: args[0] });
                }
                case "checkout": {
                    if (args.length !== 1 || args[0].startsWith("-")) {
                        return fail(
                            "bad-arguments",
                            "The isogit checkout operation accepts one existing branch or object reference.",
                            400,
                            {
                                operation: "checkout",
                                recovery: "Use 'branch <name>' then 'checkout <name>', or use EXEC[git] for native Git syntax.",
                                retryable: false,
                            },
                        );
                    }
                    await git.checkout({ fs, dir, ref: args[0] });
                    return ok({ checkedOut: args[0] });
                }
                default:
                    return fail(
                        "unknown-operation",
                        `Isogit does not implement '${verb ?? ""}'.`,
                        400,
                        {
                            operation: verb ?? "",
                            availableOperations: OPERATIONS,
                            recovery: "Use a supported isogit operation or EXEC[git] for native Git.",
                            retryable: false,
                        },
                    );
            }
        } catch (err) {
            if (signal.aborted) {
                return fail(
                    "cancelled",
                    "Isogit execution was cancelled.",
                    499,
                    {
                        operation: verb ?? "",
                        retryable: false,
                    },
                );
            }
            return fail(
                "operation-failed",
                `The isogit '${verb ?? ""}' operation failed: ${ErrorDetail.preview(err, detailLimit)}.`,
                500,
                {
                    operation: verb ?? "",
                    recovery: "Correct the operation or use EXEC[git] for native Git semantics.",
                    retryable: false,
                },
            );
        }
    }
}

type Fail = (
    kind: string,
    message: string,
    status?: number,
    extensions?: Readonly<Record<string, unknown>>,
) => ExecResult;

const unsupportedForm = (fail: Fail, operation: string): ExecResult =>
    fail(
        "bad-arguments",
        `The isogit ${operation} arguments are outside its supported subset.`,
        400,
        {
            operation,
            recovery: "Use the documented isogit form or EXEC[git] for native Git syntax.",
            retryable: false,
        },
    );

const statusWord = (head: number, workdir: number, stage: number): string => {
    if (head === 0 && workdir === 2) return stage === 0 ? "untracked" : "added";
    if (head === 1 && workdir === 0) return "deleted";
    if (workdir === 2 && stage === 2) return "staged";
    return "modified";
};

const authorFrom = async (dir: string): Promise<{ name: string; email: string } | null> => {
    const [name, email] = await Promise.all([
        git.getConfig({ fs, dir, path: "user.name" }),
        git.getConfig({ fs, dir, path: "user.email" }),
    ]);
    return name && email ? { name, email } : null;
};
