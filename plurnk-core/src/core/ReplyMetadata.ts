import { MetadataOptions, type SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

// {§message-completion}: only the message-reply owner interprets a completion code.
export default class ReplyMetadata {
    static read(metadata: readonly string[] | null):
        { completion: 200 | 499 | null; metadata: string[] | null } | { failure: SchemeResult } {
        const read = MetadataOptions.read(metadata, "message:reply");
        if ("failure" in read) return read;
        const codes = read.elements.filter((value) => typeof value === "number");
        if (codes.length > 1 || codes.some((value) => value !== 200 && value !== 499)) {
            return { failure: Results.failure("message:reply", "completion-invalid", 400,
                "A reply accepts one completion code: 200 or 499.", {}, { retryable: false }) };
        }
        const options = read.elements.filter((value) => typeof value !== "number");
        return {
            completion: (codes[0] as 200 | 499 | undefined) ?? null,
            metadata: options.length === 0 ? null : [options.map((value) => JSON.stringify(value)).join(",")],
        };
    }
}
