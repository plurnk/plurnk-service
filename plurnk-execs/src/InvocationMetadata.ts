import { MetadataOptions, Results, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ExecInput, ExecPreparation } from "./types.ts";

type Options = Record<string, never>;
type Parsed = { options: Options } | { failure: SchemeResult };

// {§executor-metadata} The executor framework READS the heading's `[metadata]` as a JSON array
// of option objects — house policy, not a language rule ({§slot-order}); the
// default executor contract owns no metadata keys beyond the service's ({§manifest}).
export default class InvocationMetadata {
    static parse(input: ExecInput): Parsed {
        const fail = (code: string, detail: string, recovery?: string): Parsed => ({
            failure: Results.failure("executor:metadata", code, 400, detail, {}, {
                runtime: input.runtime, ...(recovery === undefined ? {} : { recovery }), retryable: false,
            }),
        });
        const read = MetadataOptions.parse(input.metadata, "executor:metadata", { runtime: input.runtime });
        if ("failure" in read) return read;
        for (const [field] of Object.entries(read.options)) {
            return fail("metadata-unsupported", `Executable tool '${input.runtime}' does not accept metadata field '${field}'.`, InvocationMetadata.#fields());
        }
        return { options: {} };
    }

    // {§executor-metadata} — an unsupported field's recovery names every field the run takes, the
    // service's ({§manifest}), and no guess at the field the author meant ({§diagnostic-observation}).
    static #fields(): string {
        const names = MetadataOptions.SERVICE_KEYS.map((name) => `\`${name}\``);
        return names.length === 1
            ? `Its field is ${names[0]}.`
            : `Its fields are ${names.slice(0, -1).join(", ")} and ${names.at(-1)!}.`;
    }

    static async prepare(input: ExecInput): Promise<ExecPreparation> {
        const parsed = this.parse(input);
        if ("failure" in parsed) return parsed.failure;
        return { status: 200, cwd: input.cwd };
    }
}
