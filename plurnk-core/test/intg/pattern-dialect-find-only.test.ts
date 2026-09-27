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
    const ids = await seedEnvelope(db, `find-only-${crypto.randomUUID()}`);
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

// The recorded shapes (#853): `READ (django/urls/resolvers.py) &RoutePattern`, 278 refusals that never
// said the matcher is FIND's alone nor what to write instead.
test("{§pattern-dialect-find-only}: a &graph READ names FIND as its only taker and gives both working forms", async (t) => {
    const { dispatch } = await runtime(t);
    const refused = await dispatch("````READ (worker:///resolvers.py) &RoutePattern````");
    assert.equal(refused.status, 400);
    assert.equal(refused.problem.detail, "`&RoutePattern` is a &graph matcher, and only FIND takes one: it locates across resources, not lines within one.");
    assert.equal(refused.problem.recovery, "Locate it with `FIND (worker:///resolvers.py) &RoutePattern`, or select lines with a text pattern: `READ (worker:///resolvers.py) /RoutePattern/`.");
    const text = await dispatch("````READ (worker:///resolvers.py) /RoutePattern/````");
    assert.equal(text.status, 200, "the text form the recovery gives works");
    assert.equal(text.content, "class RoutePattern(CheckURLMixin):\n    return RoutePattern(path)");
    const find = await dispatch("````FIND (worker:///resolvers.py) &RoutePattern````");
    assert.ok(find.status < 400, `the FIND form the recovery gives is admitted: ${JSON.stringify(find)}`);
    const callers = await dispatch("````READ (worker:///resolvers.py) &<resolve````");
    assert.equal(callers.problem.recovery, "Locate it with `FIND (worker:///resolvers.py) &<resolve`, or select lines with a text pattern: `READ (worker:///resolvers.py) /resolve/`.");
});

test("{§pattern-dialect-find-only}: a ~full-text KILL gets the same two forms with its words as one regex", async (t) => {
    const { dispatch } = await runtime(t);
    const refused = await dispatch("````KILL (worker:///resolvers.py) ~locale regex.descriptor````");
    assert.equal(refused.status, 400);
    assert.equal(refused.problem.detail, "`~locale regex.descriptor` is a ~full-text matcher, and only FIND takes one: it locates across resources, not lines within one.");
    assert.equal(refused.problem.recovery, "Locate it with `FIND (worker:///resolvers.py) ~locale regex.descriptor`, or select lines with a text pattern: `KILL (worker:///resolvers.py) /locale|regex\\.descriptor/`.");
});
