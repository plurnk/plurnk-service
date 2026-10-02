import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "../core/Db.ts";
import DerivationUse from "./_derivation-use.ts";

test("{§derivation-in-flight}: concurrent consumers are not serialized and collection waits for neither", async () => {
    const db = {} as Db;
    const release = Promise.withResolvers<void>();
    const entered: number[] = [];
    const uses = [1, 2].map((id) => DerivationUse.read(db, async () => {
        entered.push(id);
        await release.promise;
    }));
    assert.deepEqual(entered, [1, 2]);
    assert.equal(await DerivationUse.collect(db, async () => { throw new Error("must not collect in-use sources"); }), null);
    release.resolve();
    await Promise.all(uses);
    assert.equal(await DerivationUse.collect(db, async () => "collected"), "collected");
});

test("{§derivation-in-flight}: new consumers wait for collection, including failed collection", async () => {
    const db = {} as Db;
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const failure = new Error("collector failed");
    const collecting = DerivationUse.collect(db, async () => {
        events.push("collect");
        await release.promise;
        throw failure;
    });
    const rejected = assert.rejects(collecting, (error) => error === failure);
    const read = DerivationUse.read(db, async () => { events.push("read"); });
    assert.deepEqual(events, ["collect"]);
    release.resolve();
    await Promise.all([read, rejected]);
    assert.deepEqual(events, ["collect", "read"]);
    await assert.rejects(DerivationUse.read(db, async () => { throw failure; }), (error) => error === failure);
    assert.equal(await DerivationUse.collect(db, async () => "released"), "released");
});
