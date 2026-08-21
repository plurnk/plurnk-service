import test from "node:test";
import assert from "node:assert/strict";
import { listModelCatalog } from "./model-catalog.ts";

test("{§model-catalog}: configured discovery exposes every ready model under one exact provider/model selector", () => {
    const page = listModelCatalog({ provider: "deepseek" }, { DEEPSEEK_API_KEY: "configured" });
    assert.ok(page.total > 0);
    assert.equal(page.items.length, page.total);
    assert.equal(page.nextOffset, undefined);
    assert.ok(page.items.every(({ provider, selector, readiness }) =>
        provider === "deepseek"
        && selector.startsWith("deepseek/")
        && readiness.ready
        && readiness.causes.length === 0));
    assert.deepEqual(
        page.items.map(({ selector }) => selector),
        page.items.map(({ selector }) => selector).toSorted(),
        "catalog order is stable and route-oriented",
    );
});

test("{§model-catalog}: the broad catalog reports missing local configuration without probing or hiding models", () => {
    const page = listModelCatalog({
        provider: "cloudflare",
        availability: "all",
        limit: 1,
    }, {});
    assert.equal(page.items.length, 1);
    assert.ok(page.total > 1);
    assert.equal(page.nextOffset, 1);
    const [entry] = page.items;
    assert.equal(entry.provider, "cloudflare");
    assert.equal(entry.readiness.ready, false);
    assert.deepEqual(entry.readiness.causes, [
        { kind: "configuration", alternatives: [["CLOUDFLARE_ACCOUNT_ID"]] },
        { kind: "credential", alternatives: [["CLOUDFLARE_API_KEY"]] },
    ]);
    assert.equal(Object.hasOwn(entry.capabilities, "reasoning"), true);
    assert.ok(entry.limits.contextTokens > 0);
});

test("{§model-catalog}: search and pagination apply to the complete filtered result before slicing", () => {
    const complete = listModelCatalog({
        provider: "deepseek",
        search: "DeepSeek",
        availability: "all",
        limit: 100,
    }, {});
    const page = listModelCatalog({
        provider: "deepseek",
        search: "deepseek",
        availability: "all",
        offset: 1,
        limit: 2,
    }, {});
    assert.equal(page.total, complete.total);
    assert.deepEqual(page.items, complete.items.slice(1, 3));
    assert.equal(page.nextOffset, complete.total > 3 ? 3 : undefined);
});

test("{§model-catalog}: no configured provider means the default page is honestly empty", () => {
    assert.deepEqual(listModelCatalog({}, {}), { items: [], offset: 0, total: 0 });
});
