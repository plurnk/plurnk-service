import assert from "node:assert/strict";
import test from "node:test";
import PreparationDiagnostics from "./PreparationDiagnostics.ts";

test("{§mcp-preparation-diagnostics}: a bounded stderr tail redacts values across chunks and retained-buffer boundaries", () => {
    const secret = "fixture-[secret]-value";
    const capture = new PreparationDiagnostics([secret], 48);
    for (const chunk of ["discarded history\n", "older line\n".repeat(30), "last line ", secret.slice(0, 8), secret.slice(8), " failed\n"]) {
        capture.write(Buffer.from(chunk));
    }
    const result = capture.describe(new Error(`wrapper ${secret}`, { cause: new Error(`rejected ${secret}`) }));
    assert.match(result.diagnostic ?? "", /rejected __redacted__/u);
    assert.match(result.stderr ?? "", /last line __redacted__ failed/u);
    assert.doesNotMatch(JSON.stringify(result), /fixture-|secret|discarded/u);
    assert.ok((result.stderr?.length ?? 0) <= 48);
    assert.ok((result.diagnostic?.length ?? 0) <= 48);

    const boundary = new PreparationDiagnostics([secret], 12);
    boundary.write(Buffer.from(`old text ${secret} failed`));
    assert.doesNotMatch(boundary.describe(new Error("closed")).stderr ?? "", /secret|value/u);
});

test("{§mcp-preparation-diagnostics}: overlapping values and heavily shortened tails reveal no value fragments", () => {
    const capture = new PreparationDiagnostics(["abc", "cde", "long-private-value"], 36);
    capture.write(Buffer.from(`older text abcdef ${"long-private-value ".repeat(8)}failed`));
    const result = capture.describe(new Error("abcdef"));
    assert.equal(result.diagnostic, "__redacted__f");
    assert.match(result.stderr ?? "", /failed$/u);
    assert.doesNotMatch(JSON.stringify(result), /private|value|abc|cde/u);
});

test("{§mcp-preparation-diagnostics}: shortening earlier secrets cannot reveal the truncated diagnostic suffix", () => {
    const secret = "synthetic-key-that-is-long-enough";
    for (const limit of [12, 24, 40, 64]) {
        const capture = new PreparationDiagnostics([secret], limit);
        const result = capture.describe(new Error(`${secret} `.repeat(10)));
        assert.match(result.diagnostic ?? "", /__redacted__/u);
        assert.doesNotMatch(result.diagnostic ?? "", /synthetic|key|enough/u);
        assert.ok((result.diagnostic?.length ?? 0) <= limit);
    }
});

test("{§mcp-preparation-diagnostics}: prefix and tail windows mask every intersecting known value", () => {
    const secret = "Z9Qx".repeat(12);
    for (const limit of [1, 12, 24, 48, 64]) {
        for (const offset of [0, 1, secret.length - 1]) {
            const capture = new PreparationDiagnostics([secret], limit);
            const text = `${"|".repeat(offset)}${`${secret}|`.repeat(5)}${"|".repeat(offset)}`;
            for (let start = 0; start < text.length; start += 7) capture.write(Buffer.from(text.slice(start, start + 7)));
            const result = capture.describe(new Error(text));
            for (const field of [result.diagnostic, result.stderr]) {
                assert.ok(field !== undefined);
                assert.doesNotMatch(field, /[Z9Qx]/u, `limit=${limit}, offset=${offset}`);
                assert.ok(field.length <= limit);
            }
        }
    }
});

test("{§mcp-preparation-diagnostics}: diagnostic text is bounded, cycle-safe, and preserves UTF-8 across chunks", () => {
    const capture = new PreparationDiagnostics([], 80);
    const bytes = Buffer.from("échec — last line\n");
    for (const byte of bytes) capture.write(Buffer.of(byte));
    const cause = new Error("request timed out");
    cause.cause = cause;
    const result = capture.describe(new AggregateError([cause, new Error("cleanup failed")], "preparation failed"));
    assert.match(result.diagnostic ?? "", /request timed out/u);
    assert.match(result.diagnostic ?? "", /cleanup failed/u);
    assert.equal(result.stderr, "échec — last line");
    assert.ok((result.diagnostic?.length ?? 0) <= 80);
});

test("{§mcp-preparation-diagnostics}: a zero diagnostic bound retains no text", () => {
    const capture = new PreparationDiagnostics(["secret"], 0);
    capture.write(Buffer.from("stderr secret"));
    assert.deepEqual(capture.describe(new Error("failed secret")), {});
});
