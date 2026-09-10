import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Results, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ExecInput, ExecPreparation } from "./types.ts";

type Options = { cwd?: string; args: string[]; stdin?: "open" };
type Accepted = { args?: boolean; stdin?: boolean };
type Parsed = { options: Options } | { failure: SchemeResult };

// {§executor-metadata} The executor framework owns these options, not Core.
export default class InvocationMetadata {
    static parse(input: ExecInput, accepted: Accepted = {}): Parsed {
        const options: Options = { args: [] };
        const fields = new Set<string>();
        const fail = (code: string, detail: string): Parsed => ({
            failure: Results.failure("executor:metadata", code, 400, detail, {}, {
                runtime: input.runtime, retryable: false,
            }),
        });
        for (const block of input.metadata ?? []) {
            const match = /^([a-zA-Z][a-zA-Z0-9_]*)=(.*)$/su.exec(block.trim());
            if (match === null) return fail("invalid-metadata", "Execution options use `{name=value}`.");
            const field = match[1]!;
            const value = match[2]!;
            if (field !== "cwd" && !(accepted.args && field === "args") && !(accepted.stdin && field === "stdin")) {
                return fail("metadata-unsupported", `Executable tool '${input.runtime}' does not accept metadata field '${field}'.`);
            }
            if (fields.has(field)) return fail("duplicate-metadata", `Execution option '${field}' occurs more than once.`);
            fields.add(field);
            if (field === "stdin") {
                if (value !== "open") return fail("invalid-stdin", "Execution stdin accepts only 'open'.");
                options.stdin = "open";
                continue;
            }
            if (field === "cwd") {
                if (value.length === 0 || value.includes("\0")) return fail("invalid-cwd", "Execution cwd must be a nonempty directory path without NUL.");
                options.cwd = value;
                continue;
            }
            let args: unknown;
            try {
                args = JSON.parse(value);
            } catch (cause) {
                if (!(cause instanceof SyntaxError)) throw cause;
                return fail("invalid-args", "Execution args must be a JSON array of strings without NUL.");
            }
            if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
                return fail("invalid-args", "Execution args must be a JSON array of strings without NUL.");
            }
            options.args = args;
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
