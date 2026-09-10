import test from "node:test";
import assert from "node:assert/strict";
import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type { SchemeAddressCtx, SchemeHandler } from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
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
    fragment: "body",
};

const context: PlurnkSchemeContext = {
    db: {} as Db,
    workspaceId: 11,
    workerId: 22,
    loopId: 33,
    turnId: 44,
    writer: "model",
    signal: undefined,
    weigh: () => 0,
};

const manifest: SchemeManifest = {
    name: "test", authority: "resource", channels: { body: "text/plain" }, defaultChannel: "body",
    category: "data", writableBy: ["model"], volatile: false, modelVisible: true,
};

test("{§entry-address-resolution} canonical coordinates carry no storage principal", async () => {
    let received: ParsedPath | undefined;
    const handler: SchemeHandler = {
        async resolveEntryAddress(address) {
            received = address;
            return { authority: "canonical.example", pathname: "/canonical" };
        },
    };
    const resolved = await new EntryAddressBinding().resolve({ target, routedScheme: "test", handler, manifest, ctx: context });
    assert.equal(received?.kind === "url" ? received.fragment : undefined, null);
    assert.deepEqual(resolved, {
        address: { scheme: "test", authority: "canonical.example", pathname: "/canonical" },
        result: null,
    });
});

test("{§entry-address-resolution} address resolution receives identity but no storage capabilities", async () => {
    let received: SchemeAddressCtx | undefined;
    const handler: SchemeHandler = {
        async resolveEntryAddress(_address, ctx) {
            received = ctx;
            return { authority: "", pathname: "/item" };
        },
    };
    await new EntryAddressBinding().resolve({ target, routedScheme: "test", handler, manifest, ctx: context });
    assert.deepEqual(Object.keys(received ?? {}).toSorted(), ["loopId", "signal", "turnId", "workerId", "workspaceId", "writer"]);
});

test("{§entry-address-resolution} intrinsic read-only resources reject writes before storage binding", async () => {
    const seen: Array<string | undefined> = [];
    const denied = Results.failure("scheme:test", "read-only", 403, "This address is read-only.");
    const handler: SchemeHandler = {
        async resolveEntryAddress(_address, _ctx, access) {
            seen.push(access);
            return access === "write" ? denied : { authority: "", pathname: "/item" };
        },
    };
    const binding = new EntryAddressBinding();
    const args = { target, routedScheme: "test", handler, manifest, ctx: context };
    assert.deepEqual((await binding.resolve(args)).address, { scheme: "test", authority: "", pathname: "/item" });
    assert.deepEqual(await binding.resolve({ ...args, access: "write" }), { address: null, result: denied });
    assert.deepEqual(seen, ["read", "write"]);
});

test("{§entry-address-resolution} default resolution preserves literal authority for every caller", async () => {
    for (const workerId of [22, 99]) {
        assert.deepEqual(await new EntryAddressBinding().resolve({
            target, routedScheme: "test", handler: {}, manifest, ctx: { ...context, workerId },
        }), { address: { scheme: "test", authority: "origin.example", pathname: "/item" }, result: null });
    }
});

for (const invalid of [{ authority: "", pathname: "/item", owner: "worker" }, { authority: "", pathname: "/item", extra: 99 }]) {
    test(`{§entry-address-resolution} rejects non-coordinate fields: ${JSON.stringify(invalid)}`, async () => {
        await assert.rejects(new EntryAddressBinding().resolve({
            target, routedScheme: "test", handler: { async resolveEntryAddress() { return invalid; } }, manifest, ctx: context,
        }), /invalid entry coordinate/);
    });
}
