import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Http from "@plurnk/plurnk-schemes-http";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

test("{§http-json-presentation}: READ, FIND, COPY and previews share formatted JSON coordinates", async (t) => {
    const db = await openMigrated();
    const mimetypes = new Mimetypes();
    await mimetypes.ready();
    const ids = await seedEnvelope(db, `json-presentation-${crypto.randomUUID()}`, { producer: "client" });
    const schemes = new SchemeRegistry();
    schemes.register("https", new Http());
    const engine = new Engine({ db, schemes, mimetypes });
    const value = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field${i}`, `value${i}`]));
    const source = JSON.stringify(value);
    const formatted = JSON.stringify(value, null, 2);
    const target = "https://93.184.216.34/data.json";
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input).endsWith("/llms.txt")
        ? new Response(null, { status: 404 })
        : new Response(source, { headers: { "content-type": "application/json", "cache-control": "max-age=600" } }));
    let sequence = 0;
    const dispatch = async (dsl: string) => {
        const parsed = PlurnkParser.parse(`## PLAN_\n[]\n${dsl}`);
        const item = parsed.items.find((item) => item.kind === "statement" && item.statement.op !== "PLAN");
        assert.equal(item?.kind, "statement", dsl);
        if (item?.kind !== "statement") throw new Error("operation did not parse");
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "client", statement: item.statement });
        const row = await db.log_read_by_coordinate.get<{ rx: string }>({
            worker_id: ids.workerId, loop_seq: 1, turn_seq: 1, sequence,
        });
        assert.ok(row);
        return JSON.parse(row.rx);
    };
    try {
        const preview = await dispatch(`### READ_ (${target})`);
        assert.equal(preview.status, 200);
        assert.equal(preview.content, formatted.split("\n").slice(0, 16).join("\n"));
        const scoped = await dispatch(`### READ_ (${target}) <20,22>`);
        assert.equal(scoped.content, formatted.split("\n").slice(19, 22).join("\n"));
        const found = await dispatch(`### FIND_ (${target})\n/value19/`);
        assert.equal(found.status, 200);
        const locations = JSON.parse(found.content);
        assert.ok(locations.length > 0);
        assert.equal(locations[0].region.startLine, 21);
        assert.equal((await dispatch(`### COPY_ (${target}) <20,22> (worker:///selection.json)`)).status, 201);
        const copied = await dispatch("### READ_ (worker:///selection.json) <1,-1>");
        assert.equal(copied.content, scoped.content);
        assert.equal((await dispatch(`### EDIT_ (worker:///literal.json)\n${source}`)).status, 201);
        assert.equal((await dispatch("### READ_ (worker:///literal.json) <1,-1>")).content, source, "literal JSON resource coordinates and bytes are untouched");
    } finally {
        await mimetypes.dispose();
        await db.close();
    }
});
