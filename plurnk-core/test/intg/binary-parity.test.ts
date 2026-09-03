// {§binary-parity} — a binary member is not a second-class resource. A whole-resource COPY/MOVE
// between files transfers its bytes exactly; a byte range transfers exactly those bytes; MOVE
// relocates and deletes the source. The only refusal is authoring bytes from a text EDIT body.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";

// The task tree is a plain directory: admit its files as members, as the harness does.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

// A complete, valid 1×1 PNG (signature, IHDR, IDAT, IEND).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const mockTurn = (dsl: string) => ({
    assistant: { content: `# PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

const runCopy = async (seed: Record<string, Buffer>, dsl: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-binparity-"));
    for (const [name, bytes] of Object.entries(seed)) await writeFile(join(root, name), bytes);
    const mock = new Mock({ contextWindow: viableWindow(), responses: [mockTurn(`${dsl}\n\n## SEND0 (NEXT)\nworking`), mockTurn("## SEND0 (TERM)\ndone")] });
    let status = 0;
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `binparity-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "relocate the binary", policy: { proposals: "accept" } });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 20000 },
            );
            status = 200;
        } finally { ws.close(); }
    });
    return { root, status };
};

const gone = async (path: string): Promise<boolean> => access(path).then(() => false, () => true);

test("{§binary-parity} COPY of a whole binary file reproduces its bytes exactly", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) (copy.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "copy.png"))).equals(PNG), "the copy is byte-identical");
        assert.ok(Buffer.from(await readFile(join(root, "logo.png"))).equals(PNG), "the source is untouched by COPY");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} MOVE of a whole binary file relocates the bytes and deletes the source", async () => {
    const { root } = await runCopy({ "a.png": PNG }, "## MOVE0 (a.png) (b.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "b.png"))).equals(PNG), "the destination has the bytes");
        assert.ok(await gone(join(root, "a.png")), "the source is gone after MOVE");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} <1,-1> is the whole resource, identical to unscoped", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) <1,-1> (whole.png)");
    try {
        assert.ok(Buffer.from(await readFile(join(root, "whole.png"))).equals(PNG), "<1,-1> copies every byte");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a byte range copies exactly those bytes (coordinate = byte)", async () => {
    const { root } = await runCopy({ "logo.png": PNG }, "## COPY0 (logo.png) <1,8> (head.png)");
    try {
        // The 8-byte PNG signature, 1-indexed bytes 1..8 inclusive.
        assert.ok(Buffer.from(await readFile(join(root, "head.png"))).equals(PNG.subarray(0, 8)), "bytes 1..8 are the PNG signature");
    } finally { await rm(root, { recursive: true, force: true }); }
});

// Distinct, unambiguously-binary fixtures for the region splice (extension drives mimetype).
const BIN16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
const PATCH = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

test("{§binary-parity} a destination byte range is spliced: <c,d> becomes the source bytes, the rest untouched", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "## COPY0 (patch.png) <1,4> (target.png) <5,8>");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 4), PATCH, BIN16.subarray(8)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "bytes 5..8 became the patch, every other byte kept");
        assert.ok(Buffer.from(await readFile(join(root, "patch.png"))).equals(PATCH), "the source is untouched by the splice");
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§binary-parity} a single destination byte position inserts the source bytes before it", async () => {
    const { root } = await runCopy({ "target.png": BIN16, "patch.png": PATCH }, "## COPY0 (patch.png) <1,2> (target.png) <3>");
    try {
        const expected = Buffer.concat([BIN16.subarray(0, 2), PATCH.subarray(0, 2), BIN16.subarray(2)]);
        assert.ok(Buffer.from(await readFile(join(root, "target.png"))).equals(expected), "the two patch bytes were inserted before byte 3");
    } finally { await rm(root, { recursive: true, force: true }); }
});
