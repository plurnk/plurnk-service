import test from "node:test";
import assert from "node:assert/strict";
import { context, SpanStatusCode, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import { observed, observedSync } from "./observe.ts";

type Recorded = { name: string; attributes: Record<string, unknown>; status?: number; ended: boolean };

const recordingTracer = (): { tracer: Tracer; spans: Recorded[] } => {
    const spans: Recorded[] = [];
    const tracer = {
        startSpan(name: string, options?: SpanOptions): Span {
            const recorded: Recorded = { name, attributes: { ...(options?.attributes ?? {}) }, ended: false };
            spans.push(recorded);
            return {
                setAttribute(key: string, value: unknown) { recorded.attributes[key] = value; return this; },
                setStatus({ code }: { code: number }) { recorded.status = code; return this; },
                end() { recorded.ended = true; },
                spanContext() { return { traceId: "0", spanId: "0", traceFlags: 0 }; },
                isRecording() { return true; },
            } as unknown as Span;
        },
        startActiveSpan() { throw new Error("unused"); },
    } as unknown as Tracer;
    return { tracer, spans };
};

test("{§observed-span}: attributes are redacted to scalars, strings capped, and a failure records only the error's class", async () => {
    const { tracer, spans } = recordingTracer();
    const result = await observed(tracer, "example", { id: 7, ok: true, long: "x".repeat(400), dropped: { nested: 1 }, absent: undefined }, async () => 42);
    assert.equal(result, 42);
    assert.deepEqual(spans[0]?.attributes, { id: 7, ok: true, long: "x".repeat(300) });
    assert.equal(spans[0]?.ended, true);

    await assert.rejects(
        observed(tracer, "failing", {}, async () => { throw new RangeError("secret payload in the message"); }),
        RangeError,
    );
    assert.equal(spans[1]?.status, SpanStatusCode.ERROR);
    assert.equal(spans[1]?.attributes["error.type"], "RangeError", "the class name, never the message");
    assert.equal(spans[1]?.ended, true);
});

test("{§observed-span}: the synchronous twin behaves the same and leaves the active context untouched", () => {
    const { tracer, spans } = recordingTracer();
    const before = context.active();
    assert.equal(observedSync(tracer, "sync", { n: 1 }, () => "done"), "done");
    assert.deepEqual(spans[0]?.attributes, { n: 1 });
    assert.throws(() => observedSync(tracer, "sync-fail", {}, () => { throw new TypeError("no"); }), TypeError);
    assert.equal(spans[1]?.attributes["error.type"], "TypeError");
    assert.equal(context.active(), before);
});
