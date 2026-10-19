import { MetadataOptions, type SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

// {§message-completion}: only the message-reply owner interprets a completion code.
export default class ReplyMetadata {
    static read(metadata: readonly string[] | null):
        { completion: 200 | 499 | null; metadata: string[] | null } | { failure: SchemeResult } {
        const read = MetadataOptions.read(metadata, "message:reply");
        if ("failure" in read) return read;
        const numbers = read.elements.filter((value) => typeof value === "number");
        const codes = numbers.filter((value): value is 200 | 499 => value === 200 || value === 499);
        if (numbers.length > 1 || codes.length !== numbers.length) {
            return { failure: Results.failure("message:reply", "completion-invalid", 400,
                "A reply accepts one completion code: 200 or 499.", {}, { retryable: false }) };
        }
        const options = read.elements.filter((value) => typeof value !== "number");
        return {
            completion: codes.at(0) ?? null,
            metadata: options.length === 0 ? null : [options.map((value) => JSON.stringify(value)).join(",")],
        };
    }
}
