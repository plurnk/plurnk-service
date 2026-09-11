import type { Writable } from "node:stream";
import { MetadataOptions, Results, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { ExecInputMessage } from "./types.ts";

// {§executor-stdin} The consumer serializes deliveries; the pipe owns framing and EOF.
export default class SubprocessInput {
    readonly #stream: Writable;
    #error: Error | null = null;

    constructor(stream: Writable, lifetime: AbortSignal) {
        this.#stream = stream;
        const abort = (): void => { stream.destroy(); };
        stream.on("error", (error: Error) => { this.#error = error; });
        stream.once("close", () => lifetime.removeEventListener("abort", abort));
        lifetime.addEventListener("abort", abort, { once: true });
        if (lifetime.aborted) abort();
    }

    initial(body: string): void {
        if (body.length === 0 || this.#stream.destroyed) return;
        this.#stream.write(body, "utf8", (error) => { if (error) this.#error = error; });
    }

    receive({ body, metadata, signal }: ExecInputMessage): Promise<SchemeResult> {
        const read = MetadataOptions.parse(metadata, "executor:input");
        if ("failure" in read) return Promise.resolve(read.failure);
        const keys = Object.keys(read.options);
        if (keys.some((key) => key !== "eof") || (keys.length === 1 && read.options.eof !== true)) {
            return Promise.resolve(Results.failure("executor:input", "invalid-input-metadata", 400,
                'Stdin SEND accepts only the optional [{"eof": true}] option.', {}, { retryable: false }));
        }
        const eof = read.options.eof === true;
        const stream = this.#stream;
        if (stream.destroyed || stream.writableEnded) {
            return Promise.resolve(Results.failure("executor:input", "input-closed", 410,
                "Execution stdin is closed.", {}, { retryable: false }));
        }
        if (this.#error !== null) return Promise.resolve(this.#failure(this.#error));
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result: SchemeResult): void => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", abort);
                stream.removeListener("close", close);
                stream.removeListener("error", error);
                resolve(result);
            };
            const error = (cause: Error): void => finish(this.#failure(cause));
            const close = (): void => finish(Results.failure("executor:input", "input-closed", 410,
                "Stdin closed during input delivery; delivery may be partial.", {}, { retryable: false }));
            const abort = (): void => {
                finish(Results.failure("executor:input", "input-cancelled", 499,
                    "Input delivery was cancelled; delivery may be partial.", {}, { retryable: false }));
                stream.destroy();
            };
            const complete = (cause?: Error | null): void => {
                if (cause) { error(cause); return; }
                const bytesAccepted = Buffer.byteLength(body);
                finish({ status: 200, result: {
                    bytesAccepted, inputClosed: eof,
                    detail: `${bytesAccepted} byte${bytesAccepted === 1 ? "" : "s"} delivered to stdin; input ${eof ? "closed" : "open"}.`,
                } });
            };
            stream.once("close", close);
            stream.once("error", error);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) { abort(); return; }
            if (eof) stream.end(body, "utf8", complete);
            else if (body.length === 0) complete();
            else stream.write(body, "utf8", complete);
        });
    }

    #failure(cause: Error): SchemeResult {
        return Results.failure("executor:input", "input-write-failed", 502,
            "Stdin delivery failed; delivery may be partial.", {}, {
                errorCode: (cause as NodeJS.ErrnoException).code,
                retryable: false,
            });
    }
}
