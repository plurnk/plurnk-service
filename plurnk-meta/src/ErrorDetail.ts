import Knob from "./Knob.ts";

// {§error-detail-bound} — a package's model-facing diagnostic detail is bounded by that package's
// knob, read through the one reader: an unset or invalid bound crashes by name, never degrades.
export default class ErrorDetail {
    readonly #knob: string;

    constructor(knob: string) {
        this.#knob = knob;
    }

    limit(environ: NodeJS.ProcessEnv = process.env): number {
        return Knob.integer(this.#knob, 0, environ);
    }

    preview(value: unknown): string {
        const text = value instanceof Error ? value.message : String(value);
        const limit = this.limit();
        return text.length > limit ? `${text.slice(0, limit)}...` : text;
    }
}
