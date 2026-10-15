// {§executor-dynamic-runtimes} The common package's declarations. `sh` names the shell it runs
// ({§executor-shell}), resolved on this host; every other declaration is fixed.
import { Shell, type RuntimeDecl } from "@plurnk/plurnk-execs";

const SH: Omit<RuntimeDecl, "summary"> = {
    name: "sh",
    glyph: "🐚",
    invocation: {
        body: {
            role: "the shell program; stdin when the target is a script",
            required: false,
        },
        target: {
            role: "script; never a command or a directory",
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
        name: "node",
        glyph: "⬢",
        summary: "Run JavaScript code or scripts with Node.js.",
        invocation: {
            body: {
                role: "JavaScript program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
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
                role: "Python program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "print(42)",
            },
        },
    },
    {
        name: "perl",
        glyph: "🐪",
        summary: "Run Perl code or scripts.",
        invocation: {
            body: {
                role: "Perl program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "print 42;",
            },
        },
    },
    {
        name: "ruby",
        glyph: "💎",
        summary: "Run Ruby code or scripts.",
        invocation: {
            body: {
                role: "Ruby program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "puts 42",
            },
        },
    },
    {
        name: "lua",
        glyph: "🌙",
        summary: "Run Lua code or scripts.",
        invocation: {
            body: {
                role: "Lua program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "print(42)",
            },
        },
    },
    {
        name: "deno",
        glyph: "🦕",
        summary: "Run TypeScript or JavaScript code or scripts with Deno.",
        invocation: {
            body: {
                role: "Deno program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "console.log(42)",
            },
        },
    },
    {
        name: "bun",
        glyph: "🥟",
        summary: "Run TypeScript or JavaScript code or scripts with Bun.",
        invocation: {
            body: {
                role: "Bun program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "console.log(42)",
            },
        },
    },
    {
        name: "tcl",
        glyph: "🪶",
        summary: "Run Tcl code or scripts.",
        invocation: {
            body: {
                role: "Tcl program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "puts 42",
            },
        },
    },
    {
        name: "bc",
        glyph: "🧮",
        summary: "Evaluate calculations with bc.",
        invocation: {
            body: {
                role: "bc program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "6 * 7",
            },
        },
    },
    {
        name: "awk",
        glyph: "🪄",
        summary: "Run AWK code or scripts.",
        invocation: {
            body: {
                role: "AWK program; stdin when the target is a script",
                required: false,
            },
            target: {
                role: "script; never a command or a directory",
                required: false,
                kind: "script",
            },
            example: {
                body: "BEGIN { print 42 }",
            },
        },
    },
];

export const runtimes = (): RuntimeDecl[] => [{ ...SH, summary: Shell.summary(Shell.current()) }, ...FIXED];
