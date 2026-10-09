import assert from "node:assert/strict";
import test from "node:test";
import { routeForSpec, specForRoute } from "../../src/server/model-route.ts";
import { openMigrated } from "./_db.ts";

test("{§worker-model-selection}: concurrent first selections share one immutable resolved route", async (t) => {
    const db = await openMigrated();
    try {
        const query = db.model_route_lookup;
        const get = query.get.bind(query);
        const bothRead = Promise.withResolvers<void>();
        let reads = 0;
        t.mock.method(query, "get", async (...args: Parameters<typeof get>) => {
            const row = await get(...args);
            if (++reads === 2) bothRead.resolve();
            await bothRead.promise;
            return row;
        });
        const spec = { provider: "openai", model: "first-selection" };
        const ids = await Promise.all([routeForSpec(db, spec), routeForSpec(db, spec)]);
        assert.ok(ids[0] !== null);
        assert.equal(ids[0], ids[1]);
        assert.deepEqual(await specForRoute(db, ids[0]), spec);
        assert.equal(await routeForSpec(db, spec), ids[0], "later lookup preserves the original identity");
        for (const distinct of [
            { ...spec, alias: "local" },
            { ...spec, baseUrl: "http://127.0.0.1:8080/v1" },
            { ...spec, model: "other-model" },
            { ...spec, provider: "other-provider" },
        ]) {
            const other = await routeForSpec(db, distinct);
            assert.notEqual(other, ids[0]);
            assert.deepEqual(await specForRoute(db, other), distinct);
            assert.deepEqual(await specForRoute(db, ids[0]), spec, "another selection never rewrites the original route");
        }
    } finally { await db.close(); }
});
