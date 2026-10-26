import { MetadataOptions, Results, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ExecInput, ExecPreparation } from "./types.ts";

type Options = { args: string[] };
type Accepted = { args?: boolean };
type Parsed = { options: Options } | { failure: SchemeResult };

// {§executor-metadata} The executor framework owns these options, not Core. The
// framework READS the heading's `[metadata]` as a JSON array of option objects — house policy,
// not a language rule ({§scheme-metadata-modifier});
// the key this framework knows is `args`.
export default class InvocationMetadata {
    static parse(input: ExecInput, accepted: Accepted = {}): Parsed {
        const fail = (code: string, detail: string, recovery?: string): Parsed => ({
            failure: Results.failure("executor:metadata", code, 400, detail, {}, {
                runtime: input.runtime, ...(recovery === undefined ? {} : { recovery }), retryable: false,
            }),
        });
        const read = MetadataOptions.parse(input.metadata, "executor:metadata", { runtime: input.runtime });
        if ("failure" in read) return read;
        const options: Options = { args: [] };
        for (const [field, value] of Object.entries(read.options)) {
            if (!(accepted.args && field === "args")) {
                return fail("metadata-unsupported", `Executable tool '${input.runtime}' does not accept metadata field '${field}'.`, InvocationMetadata.#fields(accepted));
            }
            if (!Array.isArray(value) || !value.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0"))) {
                return fail("invalid-args", "Execution args must be a JSON array of strings without NUL.");
            }
            options.args = value;
        }
        return { options };
    }

    // {§executor-metadata} — an unsupported field's recovery names every field the run takes, the
    // executor's own and the service's ({§service-metadata-keys}), and no guess at the field the
    // author meant ({§diagnostic-observation}).
    static #fields(accepted: Accepted): string {
        const names = [...(accepted.args === true ? ["args"] : []), ...MetadataOptions.SERVICE_KEYS]
            .map((name) => `\`${name}\``);
        return names.length === 1
            ? `Its field is ${names[0]}.`
            : `Its fields are ${names.slice(0, -1).join(", ")} and ${names.at(-1)!}.`;
    }

    static async prepare(input: ExecInput, accepted: Accepted = {}): Promise<ExecPreparation> {
        const parsed = this.parse(input, accepted);
        if ("failure" in parsed) return parsed.failure;
        return { status: 200, cwd: input.cwd };
    }
}
