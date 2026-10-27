// {§executor-discovery} The common package's declarations. `sh` names the shell it runs
// ({§executor-subprocess}), resolved on this host; every other declaration is fixed.
import { Shell, type RuntimeDecl } from "@plurnk/plurnk-execs";

const SH: Omit<RuntimeDecl, "summary"> = {
    name: "sh",
    glyph: "🐚",
    invocation: {
        body: {
            role: "the shell program; arguments when the target is a script",
            required: false,
        },
        target: {
            role: "script, or working directory for an inline program",
            required: false,
            kind: "script",
        },
        example: {
            body: "git status --short",
        },
    },
};

const FIXED: readonly RuntimeDecl[] = [
    {
        name: "js",
        glyph: "⬢",
        summary: "Run JavaScript code or scripts with Node.js.",
        invocation: {
            body: {
                role: "JavaScript program; arguments when the target is a script",
                required: false,
            },
            target: {
                role: "script, or working directory for an inline program",
                required: false,
                kind: "script",
            },
            example: {
                body: "console.log(42)",
            },
        },
    },
    {
        name: "python3",
        glyph: "🐍",
        summary: "Run Python 3 code or scripts.",
        invocation: {
            body: {
                role: "Python program; arguments when the target is a script",
                required: false,
            },
            target: {
                role: "script, or working directory for an inline program",
                required: false,
                kind: "script",
            },
            example: {
                body: "print(42)",
            },
        },
    },
];

export const runtimes = (): RuntimeDecl[] => [{ ...SH, summary: Shell.summary(Shell.current()) }, ...FIXED];
