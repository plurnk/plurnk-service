import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type PlurnkStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { openMigrated, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { fixtureExecutors } from "./_mock.ts";

const RESOLVERS = [
    "class RoutePattern(CheckURLMixin):",
    "    regex = LocaleRegexDescriptor('_route')",
    "def resolve(self, path):",
    "    return RoutePattern(path)",
].join("\n");

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `indexed-pattern-${crypto.randomUUID()}`);
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
    await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, pathname: "/resolvers.py", content: RESOLVERS, mimetype: "text/x-python" });
    return { dispatch, db };
};

// {§read-pattern} {§graph-relations}
test("a graph READ selects definitions and references without becoming a FIND", async (t) => {
    const { dispatch } = await runtime(t);
    const definition = await dispatch("````READ (worker:///resolvers.py) &RoutePattern````");
    assert.equal(definition.status, 200);
    assert.equal(definition.content, "class RoutePattern(CheckURLMixin):\n    regex = LocaleRegexDescriptor('_route')");
    assert.deepEqual(definition.lineOrdinals, [1, 2]);
    const reference = await dispatch("````READ (worker:///resolvers.py) &<RoutePattern````");
    assert.equal(reference.status, 200);
    assert.equal(reference.content, "    return RoutePattern(path)");
    assert.deepEqual(reference.matches.map(({ region }: { region: unknown }) => region), [
        { startLine: 4, startColumn: 12, endLine: 4, endColumn: 24 },
    ]);
    const find = await dispatch("````FIND (worker:///resolvers.py) &RoutePattern````");
    assert.equal(find.status, 200);
    assert.deepEqual(find.results.map(({ region }: { region: unknown }) => region), definition.matches.map(({ region }: { region: unknown }) => region));
});

// {§kill-pattern}
test("a full-text KILL removes the highlighted source token rather than its containing line", async (t) => {
    const { dispatch, db } = await runtime(t);
    const result = await dispatch("````KILL (worker:///resolvers.py) ~LocaleRegexDescriptor````");
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.matched, 1);
    const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/resolvers.py", name: "body" });
    assert.equal(body?.content, RESOLVERS.replace("LocaleRegexDescriptor", ""));
});
