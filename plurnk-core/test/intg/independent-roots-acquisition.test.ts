// {§scheme-entry-matrix} — identical textual acquired addresses in independent
// root Workers are distinct Worker-owned resources: no shared entry, no
// cross-perspective FIND, no render-time filtering.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { FindStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${input}`);
    const item = parsed.items.find((x) => x.kind === "statement" && x.statement.op !== "PLAN");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("two independent root Workers acquire the same https address as distinct private resources", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    await schemes.discoverExternal(process.cwd());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const originalFetch = globalThis.fetch;
    const bodies = ["alpha view of the feed", "beta view of the feed"];
    let served = 0;
    // The scheme may quietly probe same-origin companions (llms.txt); only the
    // feed itself is served, in acquisition order, one representation per root.
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith("/feed")) return new Response("", { status: 404 });
        return new Response(bodies[served++] ?? "unexpected third fetch", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    }) as typeof fetch;
    try {
        const workspaceId = await insertWorkspace(db, `independent-roots-${crypto.randomUUID()}`);
        const roots = await Promise.all(["alpha", "beta"].map(async (name) => {
            const workerId = await insertWorker(db, workspaceId, null, name);
            const loopId = await insertLoop(db, workerId, 1, "go");
            const turnId = await insertTurn(db, loopId, 1, 102);
            return { workerId, loopId, turnId };
        }));
        const dispatch = (root: (typeof roots)[number], statement: PlurnkStatement, sequence: number) =>
            engine.dispatch({ statement, workspaceId, ...root, sequence, origin: "model" });

        for (const [index, root] of roots.entries()) {
            const read = await dispatch(root, parseOne("## READ0 (https://example.org/feed)") as ReadStatement, 1);
            assert.equal(read.status, 200);
            assert.equal(read.content, bodies[index], "each root acquires its own representation");
        }

        const owners = await db.test_entries_by_coordinate_owners.all<{ owner_id: number; content: string }>({
            scheme: "https", authority: "example.org", pathname: "/feed",
        });
        assert.deepEqual(
            owners.map(({ owner_id, content }) => ({ owner_id, content })),
            roots.map(({ workerId }, index) => ({ owner_id: workerId, content: bodies[index] })),
            "one textual coordinate, two Worker-owned entries, no commons row",
        );

        for (const [index, root] of roots.entries()) {
            const found = await dispatch(root, parseOne("## FIND0 (https://example.org/**)") as FindStatement, 2);
            assert.equal(found.status, 200);
            assert.equal(found.matchingPathCount, 1, "a root's FIND sees exactly its own acquisition");
            const reread = await dispatch(root, parseOne("## READ0 (https://example.org/feed)") as ReadStatement, 3);
            assert.equal(reread.content, bodies[index], "re-reading resolves the root's own entry, never the sibling's");
        }
        assert.equal(served, 2, "no root re-fetched the other's representation");
    } finally {
        globalThis.fetch = originalFetch;
        await schemes.close();
        await db.close();
    }
});
