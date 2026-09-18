import assert from "node:assert/strict";
import test from "node:test";
import ReadResolve from "../../src/content/read-resolve.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import LogVisibility from "../../src/core/LogVisibility.ts";
import { editReceipt, projectEditReceipt } from "../../src/content/edit-receipt.ts";
import { parseLogRecords } from "../LogRecords.ts";

const weigh = (text: string): number => Math.ceil(text.length / 4);
const content = Array.from({ length: 30 }, (_, index) => `source line ${index + 1}`).join("\n");

test("{§packet-extent-metadata}: successful retrievals format typed extents without changing their evidence", async (t) => {
    for (const { unit, total, returned, expected } of [
        { unit: "line", total: 602, returned: [1, 16], expected: "<1,16> of 602 lines" },
        { unit: "line", total: 35, returned: [1, 35], expected: "35 lines" },
        { unit: "line", total: 1, returned: [1, 1], expected: "1 line" },
        { unit: "line", total: 35, expected: "none of 35 lines" },
        { unit: "resource", total: 40, returned: [17, 32], expected: "<17,32> of 40 resources" },
        { unit: "resource", total: 0, expected: "0 resources" },
        { unit: "matchLocation", total: 40, returned: [17, 17], expected: "<17> of 40 match locations" },
        { unit: "byte", total: 4096, returned: [1, 16], expected: "<1,16> of 4096 bytes" },
    ]) {
        await t.test(expected, () => {
            const range = { unit, total, requested: [1, -1], ...(returned === undefined ? {} : { returned }) };
            const row = { coordinate: "1/2/3", op: "READ", status: 200, target: { scheme: null, pathname: "sample" }, rx: { range, content: "" } };
            const original = structuredClone(row);
            const explicit = parseLogRecords(PacketWire.renderLog([row], weigh))[0]!;
            const automatic = parseLogRecords(PacketWire.renderLog([{ ...row, origin: "_plurnk" }], weigh))[0]!;
            assert.equal(explicit.range, expected);
            assert.equal(automatic.range, expected);
            assert.equal(explicit.region, undefined);
            assert.equal(explicit.lines, undefined);
            assert.deepEqual(row, original, "packet formatting does not mutate durable result facts");
        });
    }
});

test("{§packet-extent-metadata}: READ acquisition, receipt trimming, and READ of the log keep distinct coordinates", async () => {
    const rx = await ReadResolve.resolve({ content, mimetype: "text/plain", lineMarker: { marks: [17, 18] } });
    const entry = { coordinate: "1/2/3", op: "READ", status: rx.status, target: { scheme: null, pathname: "sample" }, rx };
    const original = structuredClone(rx);
    const whole = parseLogRecords(PacketWire.renderLog([entry], weigh))[0]!;
    assert.equal(whole.range, "<17,18> of 30 lines");
    assert.equal(whole.body, "17:source line 17\n18:source line 18\n");
    const scope = LogVisibility.resolveScope({ marks: [1] }, "log:///1/2/3/READ", rx.content!);
    assert.equal(scope.ok, true);
    const folded = LogVisibility.apply([], scope.range, LogVisibility.lineCount(rx.content!));
    const rendered = PacketWire.renderLog([{ ...entry, folded }], weigh);
    const trimmed = parseLogRecords(rendered)[0]!;
    assert.equal(trimmed.range, whole.range, "curation does not rewrite acquisition evidence");
    assert.deepEqual(trimmed.trimmed, ["<1>"]);
    assert.equal(trimmed.folded, undefined);
    assert.equal(trimmed.body, "18:source line 18\n");
    assert.equal(trimmed.logTokens, weigh(rendered), "the new metadata participates in exact row accounting");
    const reread = await ReadResolve.resolve({
        content: rx.content!, mimetype: "text/plain", lineMarker: { marks: [1, -1] },
        visibleLines: LogVisibility.visibleLineOrdinals(folded, LogVisibility.lineCount(rx.content!)),
    });
    const observed = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/3/1", op: "READ", status: reread.status,
        target: { scheme: "log", pathname: "/1/2/3/READ" }, rx: reread,
    }], weigh))[0]!;
    assert.equal(observed.range, "<2> of 2 lines");
    assert.equal(observed.body, "2:source line 18\n");
    assert.deepEqual(rx, original, "the immutable acquisition retains both original source lines");
});

test("{§packet-extent-metadata}: sparse acquisitions do not become complete merely by spanning both endpoints", async () => {
    const rx = await ReadResolve.resolve({ content, mimetype: "text/plain", lineMarker: { marks: [1, -1] }, visibleLines: [1, 15, 30] });
    const rendered = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/2/3", op: "READ", status: rx.status, target: { scheme: null, pathname: "sample" }, rx,
    }], weigh))[0]!;
    assert.equal(rendered.range, "<1,30> of 30 lines");
    assert.match(String(rendered.body), /1:source line 1\n15:source line 15\n30:source line 30/);
});

test("{§packet-extent-metadata}: mutation scopes are resolved by the producer, not reverse-parsed by the packet", () => {
    const original = "first\nsecond\nthird";
    const updated = "first\nreplacement\nextra\nthird";
    const receipt = projectEditReceipt(editReceipt(original, updated, [{ marker: { marks: [2] }, body: "replacement\nextra" }]), 0);
    const retained = structuredClone(receipt);
    const row = parseLogRecords(PacketWire.renderLog([{
        coordinate: "1/2/3", op: "EDIT", status: 200, target: { scheme: null, pathname: "sample" }, rx: { receipt },
    }], weigh))[0]!;
    assert.equal(row.effect, "<2> -> <2,3>");
    assert.equal(row.range, undefined);
    assert.equal(row.change, "-1 +2");
    assert.equal(row.extent, "lines 3->4");
    assert.match(String(row.body), /2:replacement\n3:extra/);
    assert.deepEqual(receipt, retained);
});
