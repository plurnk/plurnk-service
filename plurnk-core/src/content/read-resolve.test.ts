import assert from "node:assert/strict";
import test from "node:test";
import ReadResolve from "./read-resolve.ts";

test("{§log-readable-projection} {§markerless-first-page}: a markerless READ of a visible-line selection returns every retained line", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const visibleLines = Array.from({ length: 24 }, (_, i) => i + 17);
    const result = await ReadResolve.resolve({ content: lines.join("\n"), mimetype: "text/plain", visibleLines, lineMarker: null });
    assert.equal(result.content, lines.slice(16, 40).join("\n"));
    assert.deepEqual(result.lineOrdinals, visibleLines);
    assert.equal(result.range?.total, 40);
    assert.deepEqual(result.range?.returned, [17, 40]);
});

test("{§log-readable-projection}: a retained superline returns whole; no character bound cuts it", async () => {
    const result = await ReadResolve.resolve({ content: `omitted\n${"😀".repeat(3000)}`, mimetype: "text/plain", visibleLines: [2], lineMarker: null });
    assert.equal(result.status, 200);
    assert.equal(result.content, "😀".repeat(3000));
    assert.deepEqual(result.lineOrdinals, [2]);
});

test("{§log-readable-projection}: sparse character scopes retain honest boundaries and separators", async () => {
    const content = "one\r\ntwo\r\nsecret\r\nfour\r\nfive";
    const selected = await ReadResolve.resolve({ content, mimetype: "text/plain", visibleLines: [2, 4], lineMarker: { marks: [1, 2, 5, 2] } });
    assert.equal(selected.content, "two\r\nfour\r\n");
    assert.deepEqual(selected.lineOrdinals, [2, 4]);
    assert.deepEqual(selected.region, { startLine: 2, startColumn: 1, endLine: 4, endColumn: 5 });
    const empty = await ReadResolve.resolve({ content, mimetype: "text/plain", visibleLines: [2, 4], lineMarker: { marks: [3] } });
    assert.equal(empty.status, 204);
    assert.equal(empty.content, "");
    assert.deepEqual(empty.lineOrdinals, []);
    assert.deepEqual(empty.range, { unit: "line", total: 5, requested: [3, 3] });
    assert.equal(empty.region, undefined);
    assert.equal((await ReadResolve.resolve({ content, mimetype: "text/plain", visibleLines: [], lineMarker: null })).status, 204);
});

test("{§markerless-first-page}: a markerless READ is the whole text; explicit scopes stay exact", async () => {
    const lines = Array.from({ length: 10 }, (_, index) => JSON.stringify({ index, text: "x".repeat(1900) }));
    const content = lines.join("\n");
    const whole = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: null });
    assert.equal(whole.content, content, "ten long JSON records arrive whole; whether they fit is decided where the row lands");
    assert.equal(whole.mimetype, "application/json", "a markerless READ keeps the channel's own mimetype");
    assert.equal(whole.range?.total, 10);
    assert.deepEqual(whole.range?.returned, [1, 10]);
    const complete = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: { marks: [1, -1] } });
    assert.equal(complete.content, content, "an explicit complete READ remains exact");
    const selected = await ReadResolve.resolve({ content, mimetype: "application/json", lineMarker: { marks: [2, 4] } });
    assert.equal(selected.content, lines.slice(1, 4).join("\n"), "explicit lines are exactly what was asked");
});

test("{§markerless-first-page}: a single long line and CRLF text return whole, separators and all", async () => {
    const emoji = await ReadResolve.resolve({ content: "😀".repeat(3000), mimetype: "text/plain", lineMarker: null });
    assert.equal(emoji.status, 200);
    assert.equal(emoji.content, "😀".repeat(3000), "no character bound cuts a line");
    const crlf = await ReadResolve.resolve({ content: "ab\r\ncdef\r\ngh", mimetype: "text/plain", lineMarker: null });
    assert.equal(crlf.content, "ab\r\ncdef\r\ngh");
    assert.equal(crlf.range?.total, 3);
});
