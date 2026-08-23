import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type { SchemeAddressCtx, SchemeHandler } from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase } from "./CoreSchemeServices.ts";
import type { Db } from "./Db.ts";
import EntryAddressBinding from "./EntryAddressBinding.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "./scheme-types.ts";

const target: ParsedPath = {
    kind: "url",
    raw: "test://origin.example/item#body",
    scheme: "test",
    username: null,
    password: null,
    hostname: "origin.example",
    port: null,
    pathname: "/item",
    query: null,
    headers: undefined,
    fragment: "body",
};

const context: PlurnkSchemeContext = {
    db: {} as Db,
    workspaceId: 11,
    workerId: 22,
    functionalityWorkerId: 22,
    loopId: 33,
    turnId: 44,
    writer: "model",
    signal: undefined,
    weigh: () => 0,
};

const manifest = (entryOwner: "worker" | "resolved"): SchemeManifest & { readonly category: "data" } => ({
    name: "test",
    authority: "resource",
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    entryOwner,
    inherit: "none",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

test("fixed Worker ownership binds the caller and strips channel selection", async () => {
    let received: ParsedPath | undefined;
    const handler: SchemeHandler = {
        async resolveEntryAddress(address) {
            received = address;
            return { authority: "canonical.example", pathname: "/canonical" };
        },
    };
    const resolved = await new EntryAddressBinding({} as Db).resolve({
        target,
        routedScheme: "test",
        handler,
        manifest: manifest("worker"),
        ctx: context,
    });

    assert.equal(received?.kind === "url" ? received.fragment : undefined, null);
    assert.deepEqual(resolved, {
        address: {
            ownerId: 22,
            scheme: "test",
            authority: "canonical.example",
            pathname: "/canonical",
        },
        result: null,
    });
});

test("address resolution receives identity but no entry capabilities", async () => {
    let received: SchemeAddressCtx | undefined;
    const handler: SchemeHandler = {
        async resolveEntryAddress(_address, ctx) {
            received = ctx;
            return { authority: "", pathname: "/item", owner: "worker" };
        },
    };
    await new EntryAddressBinding({} as Db).resolve({
        target,
        routedScheme: "test",
        handler,
        manifest: manifest("resolved"),
        ctx: context,
    });

    assert.deepEqual(Object.keys(received ?? {}).toSorted(), [
        "functionalityWorkerId",
        "loopId",
        "signal",
        "turnId",
        "workerId",
        "workspaceId",
        "writer",
    ]);
    assert.equal("entries" in (received ?? {}), false);
});

test("fixed ownership cannot be restated by a scheme", async () => {
    const handler: SchemeHandler = {
        async resolveEntryAddress() {
            return { authority: "", pathname: "/item", owner: "worker" };
        },
    };
    await assert.rejects(
        new EntryAddressBinding({} as Db).resolve({
            target,
            routedScheme: "test",
            handler,
            manifest: manifest("worker"),
            ctx: context,
        }),
        /restated its manifest-owned entry principal/,
    );
});

test("resolved ownership fails hard when the scheme omits its principal", async () => {
    await assert.rejects(
        new EntryAddressBinding({} as Db).resolve({
            target,
            routedScheme: "test",
            handler: {},
            manifest: manifest("resolved"),
            ctx: context,
        }),
        /did not resolve its declared entry owner/,
    );
});

test("only a core adapter may return a numeric principal", async () => {
    const external: SchemeHandler = {
        async resolveEntryAddress() {
            return { authority: "", pathname: "/item", ownerId: 99 } as never;
        },
    };
    await assert.rejects(
        new EntryAddressBinding({} as Db).resolve({
            target,
            routedScheme: "test",
            handler: external,
            manifest: manifest("resolved"),
            ctx: context,
        }),
        /core-only entry owner id/,
    );

    class CoreHandler extends CoreSchemeAdapterBase {
        async resolveEntryAddress() {
            return { authority: "", pathname: "/item", ownerId: 99 };
        }
    }
    const resolved = await new EntryAddressBinding({} as Db).resolve({
        target,
        routedScheme: "test",
        handler: new CoreHandler(),
        manifest: manifest("resolved"),
        ctx: context,
    });
    assert.equal(resolved.address?.ownerId, 99);
});
