import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MetadataOptions, Results, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ExecInput, ExecPreparation } from "./types.ts";

type Options = { cwd?: string; args: string[]; stdin?: "open" };
type Accepted = { args?: boolean; stdin?: boolean };
type Parsed = { options: Options } | { failure: SchemeResult };

// {§executor-metadata} The executor framework owns these options, not Core. The
// heading's `[metadata]` is one JSON array of option objects ({§scheme-metadata-modifier});
// the keys this framework knows are `cwd`, `args`, and `stdin`.
export default class InvocationMetadata {
    static parse(input: ExecInput, accepted: Accepted = {}): Parsed {
        const fail = (code: string, detail: string): Parsed => ({
            failure: Results.failure("executor:metadata", code, 400, detail, {}, {
                runtime: input.runtime, retryable: false,
            }),
        });
        const read = MetadataOptions.parse(input.metadata, "executor:metadata", { runtime: input.runtime });
        if ("failure" in read) return read;
        const options: Options = { args: [] };
        for (const [field, value] of Object.entries(read.options)) {
            if (field !== "cwd" && !(accepted.args && field === "args") && !(accepted.stdin && field === "stdin")) {
                return fail("metadata-unsupported", `Executable tool '${input.runtime}' does not accept metadata field '${field}'.`);
            }
            if (field === "stdin") {
                if (value !== "open") return fail("invalid-stdin", 'Execution stdin accepts only "open".');
                options.stdin = "open";
                continue;
            }
            if (field === "cwd") {
                if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return fail("invalid-cwd", "Execution cwd must be a nonempty directory path string without NUL.");
                options.cwd = value;
                continue;
            }
            if (!Array.isArray(value) || !value.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
                return fail("invalid-args", "Execution args must be a JSON array of strings without NUL.");
            }
            options.args = value;
        }
        return { options };
    }

    static async prepare(input: ExecInput, accepted: Accepted = {}): Promise<ExecPreparation> {
        const parsed = this.parse(input, accepted);
        if ("failure" in parsed) return parsed.failure;
        const directory = parsed.options.cwd;
        if (directory === undefined) return { status: 200, cwd: input.cwd };
        const cwd = resolve(input.cwd ?? process.cwd(), directory);
        try {
            if ((await stat(cwd)).isDirectory()) return { status: 200, cwd };
        } catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") throw cause;
        }
        return Results.failure("executor:metadata", "cwd-not-found", 400,
            `Execution cwd '${directory}' is not an existing directory.`, {}, {
                runtime: input.runtime, retryable: false,
            });
    }
}
