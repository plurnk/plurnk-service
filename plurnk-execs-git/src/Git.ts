import fs from "node:fs";
import { isAbsolute, resolve } from "node:path";
import git from "isomorphic-git";
import { BaseExecutor, ErrorDetail, Results } from "@plurnk/plurnk-execs";
import type { ChannelDecl, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";
import { tokenizeArgv } from "./tokenizeArgv.ts";

// In-process git executor — isomorphic-git, NO subprocess (#460, DIVERGENCES #15).
// The sandbox-portable versioning surface: a deployment that disables `sh` keeps
// version control with zero shell-escape surface (no aliases, hooks, pagers —
// there is no process to escape into). The deliberately limited verb set is the
// contract; full git rides the sh fallthrough (`EXEC:git …:EXEC`) where the
// deployment grants a shell. Sandboxes can't do everything (owner ruling, #460).
//
// `(target)` = the repo directory, resolved against cwd; default cwd (the
// workspace workspace). Body = `<verb> <args>`, git-ish spelling.
//
// `effect` stays the inherited `host` — mutating verbs exist and effect(target)
// must never inspect the command, so every op proposes.
export default class Git extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // In-process — nothing on PATH to check. Always available: that IS the point.
    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "isomorphic-git (in-process)" };
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
                "executor:git",
                kind,
                status,
                message,
                {},
                {
                    stage: "git",
                    directory: dir,
                    ...extensions,
                },
            );
        };
        const ok = (result: unknown): ExecResult => {
            write("results", JSON.stringify(result));
            setState("results", "closed");
            return { status: 200 };
        };
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:git");
        }

        if (signal.aborted) {
            setState("results", "errored");
            return Results.failure(
                "executor:git",
                "cancelled",
                499,
                "Git execution was cancelled.",
                {},
                {
                    stage: "git",
                    directory: dir,
                    retryable: false,
                },
            );
        }

        let argv: string[];
        try {
            argv = tokenizeArgv(command.trim());
        } catch (err) {
            return fail(
                "git-bad-arguments",
                `The git command arguments could not be parsed: ${ErrorDetail.preview(err, detailLimit)}.`,
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
                    await git.init({ fs, dir });
                    return ok({ initialized: dir });
                }
                case "status": {
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
                    if (args.length === 0) {
                        return fail(
                            "git-bad-arguments",
                            "The add operation requires at least one path.",
                            400,
                            {
                                operation: "add",
                                recovery: "Provide the paths to stage.",
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
                    if (!message) {
                        return fail(
                            "git-bad-arguments",
                            "The commit operation requires a message.",
                            400,
                            {
                                operation: "commit",
                                recovery: "Provide the message with -m.",
                                retryable: false,
                            },
                        );
                    }
                    const author = await authorFrom(dir);
                    if (author === null) {
                        return fail(
                            "git-no-author",
                            "The repository has no configured commit author name and email.",
                            500,
                            {
                                operation: "commit",
                                recovery: "Configure user.name and user.email in the repository.",
                                retryable: false,
                            },
                        );
                    }
                    const oid = await git.commit({ fs, dir, message, author });
                    return ok({ oid, message });
                }
                case "log": {
                    const n = args.indexOf("-n");
                    const depth = n !== -1 ? Number(args[n + 1]) : undefined;
                    const commits = await git.log({ fs, dir, ...(depth && Number.isFinite(depth) ? { depth } : {}) });
                    return ok(commits.map(({ oid, commit: c }) => ({
                        oid,
                        message: c.message.trim(),
                        author: c.author.name,
                        date: new Date(c.author.timestamp * 1000).toISOString(),
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
                    await git.branch({ fs, dir, ref: args[0] });
                    return ok({ created: args[0] });
                }
                case "checkout": {
                    if (args.length === 0) {
                        return fail(
                            "git-bad-arguments",
                            "The checkout operation requires a branch or object reference.",
                            400,
                            {
                                operation: "checkout",
                                recovery: "Provide the branch or object reference to check out.",
                                retryable: false,
                            },
                        );
                    }
                    await git.checkout({ fs, dir, ref: args[0] });
                    return ok({ checkedOut: args[0] });
                }
                default:
                    return fail(
                        "git-unknown-op",
                        `The in-process git executor does not implement '${verb ?? ""}'.`,
                        400,
                        {
                            operation: verb ?? "",
                            availableOperations: ["init", "status", "add", "commit", "log", "branch", "checkout"],
                            recovery: "Use a supported operation or run native git through the shell.",
                            retryable: false,
                        },
                    );
            }
        } catch (err) {
            if (signal.aborted) {
                setState("results", "errored");
                return Results.failure(
                    "executor:git",
                    "cancelled",
                    499,
                    "Git execution was cancelled.",
                    {},
                    {
                        stage: "git",
                        directory: dir,
                        operation: verb ?? "",
                        retryable: false,
                    },
                );
            }
            return fail(
                "git-error",
                `The in-process git '${verb ?? ""}' operation failed: ${ErrorDetail.preview(err, detailLimit)}.`,
                500,
                {
                    operation: verb ?? "",
                    recovery: "Run the operation with native git through the shell.",
                    retryable: false,
                },
            );
        }
    }
}

// statusMatrix row → one word. HEAD/WORKDIR/STAGE each 0|1|2(|3): absent /
// identical-to-HEAD / different. Deliberately coarse — a chooser digest, not
// porcelain.
const statusWord = (head: number, workdir: number, stage: number): string => {
    if (head === 0 && workdir === 2) return stage === 0 ? "untracked" : "added";
    if (head === 1 && workdir === 0) return "deleted";
    if (workdir === 2 && stage === 2) return "staged";
    return "modified";
};

// Commit author from the repo's own config — never invented. Both keys or null.
const authorFrom = async (dir: string): Promise<{ name: string; email: string } | null> => {
    const [name, email] = await Promise.all([
        git.getConfig({ fs, dir, path: "user.name" }),
        git.getConfig({ fs, dir, path: "user.email" }),
    ]);
    return name && email ? { name, email } : null;
};
