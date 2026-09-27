import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { openMigrated, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";

// The recorded shape (#853, orox): the module opens with a docstring, so a whole-text `^` never
// reached an import line and FIND answered 204 while the same READ selected them.
const RESOLVERS = [
    "\"\"\"",
    "This module converts requested URLs to callback view functions.",
    "\"\"\"",
    "import functools",
    "import inspect",
    "from importlib import import_module",
    "",
    "from django.conf import settings",
    "def get_resolver(urlconf=None):",
    "    return urlconf",
].join("\n");

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `find-line-anchors-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = async (source: string) => {
        const { items } = PlurnkParser.parseClient(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement as PlurnkStatement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/resolvers.py", content: RESOLVERS, mimetype: "text/plain" });
    return { dispatch };
};

const startLines = (found: { content: string }): number[] =>
    (JSON.parse(found.content) as Array<{ region: { startLine: number } }>).map(({ region }) => region.startLine);

test("{§find-line-anchors}: the recorded `FIND (x.py) /^from|^import/` locates the lines READ selects", async (t) => {
    const { dispatch } = await runtime(t);
    const found = await dispatch("````FIND (worker:///resolvers.py) /^from|^import/ <!-- current imports -->````");
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(startLines(found), [4, 5, 6, 8]);
    const read = await dispatch("````READ (worker:///resolvers.py) /^from|^import/````");
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "import functools\nimport inspect\nfrom importlib import import_module\nfrom django.conf import settings");
    const tail = await dispatch("````FIND (worker:///resolvers.py) /urlconf$/````");
    assert.equal(tail.status, 200, JSON.stringify(tail));
    assert.deepEqual(startLines(tail), [10], "`$` is a line's end as well");
});

test("{§find-line-anchors}: a log FIND anchors each line of the row it searches", async (t) => {
    const { dispatch } = await runtime(t);
    assert.equal((await dispatch("````READ (worker:///resolvers.py) <1,-1>````")).status, 200);
    const found = await dispatch("````FIND (log:///1/1/1/READ) /^from|^import/````");
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.deepEqual(startLines(found), [4, 5, 6, 8]);
});
