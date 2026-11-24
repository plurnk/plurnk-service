import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    Problems,
    UNKNOWN_POSITION,
    type FindStatement,
    type FunctionalityFamilyHandle,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import FunctionalityResourceFacet from "./FunctionalityResourceFacet.ts";
import type { SchemeCtx } from "./ctx.ts";
import type { ResolvedEditStatement } from "./edit-receipt.ts";

const urlTarget = (scheme: string, pathname: string, hostname = ""): ParsedPath => ({
    kind: "url",
    raw: `${scheme}://${hostname}${pathname}`,
    scheme,
    username: null,
    password: null,
    hostname,
    port: null,
    pathname,
    query: null,
    fragment: null,
});

const createMockCtx = (storedPaths: readonly string[] = []) => {
    const writes: Array<{ pathname: string; content: string; mimetype: string }> = [];
    const deletes: string[] = [];
    const ctx = {
        workspaceId: 7,
        sessionId: 11,
        loopId: 1,
        turnId: 1,
        writer: "model",
        entries: {
            write: async (pathname: string, data: { channels: { results: { content: string; mimetype: string } } }) => {
                writes.push({
                    pathname,
                    content: data.channels.results.content,
                    mimetype: data.channels.results.mimetype,
                });
                return { status: 200 };
            },
            delete: async (pathname: string) => {
                deletes.push(pathname);
                return { status: 200 };
            },
            operations: {
                find: async () => ({
                    status: 200,
                    results: storedPaths.map((path) => [{ path }]),
                }),
            },
        },
    } as unknown as SchemeCtx;
    return { ctx, writes, deletes };
};

describe("FunctionalityResourceFacet", () => {
    test("{§resource-tree-scheme} prepares exact representations, materializes find, and evicts stale stored entries", async () => {
        const invocations: Array<{ verb: string; params: unknown }> = [];
        let definitions = [
            { alias: "alpha", origin: "workspace" as const, state: "active" as const, definition: { cmd: "a" } },
            { alias: "svc", origin: "service" as const, state: "active" as const, definition: { cmd: "s" } },
        ];
        const handle: FunctionalityFamilyHandle = {
            invoke: async (verb, params) => {
                invocations.push({ verb, params });
                if (verb === "list") return { status: 200, body: { family: "demo", definitions, offset: 0, total: definitions.length } };
                return { status: 200, body: {} };
            },
            refresh: async () => {},
        };
        const facet = new FunctionalityResourceFacet({
            owner: "demo:resource",
            scheme: "demo",
            handle: () => handle,
            manifest: { writableBy: ["model", "client"] },
            claims: (p) => p.startsWith("/items") || p === "/alpha",
            aliasFromPathname: (pathname) => {
                const match = /^\/(?:items\/)?([^/]+)$/u.exec(pathname);
                if (match === null || match[1] === "items") return null;
                try {
                    return decodeURIComponent(match[1]);
                } catch {
                    return null;
                }
            },
            pathnameOfAlias: (alias) => `/items/${encodeURIComponent(alias)}`,
            authorityDetail: "Demo resources use an empty authority.",
            notFoundDetail: "The demo resource does not exist.",
            wholeEditDetail: "One edit sets one demo definition, whole.",
            wholeKillDetail: "kill retires the whole demo definition.",
            invalidTarget: { code: "target-required", detail: "The operation needs a demo:///items/<alias> target." },
            toEditInvocation: FunctionalityResourceFacet.jsonReplaceInvocation(
                "demo:resource",
                "The demo definition body must be a JSON object.",
            ),
        });

        assert.equal(facet.claims("/items/alpha"), true);
        assert.equal(facet.claims("/other/path"), false);

        const { ctx, writes, deletes } = createMockCtx([
            "demo:///items/alpha",
            "demo:///items/stale-one",
            "demo:///other/ignored",
        ]);

        const badAuth = await facet.prepareRepresentation(
            { target: urlTarget("demo", "/items/alpha", "host"), headers: null, authority: "host", pathname: "/items/alpha" },
            ctx,
        );
        assert.equal(badAuth.status, 400);

        const badPath = await facet.prepareRepresentation(
            { target: urlTarget("demo", "/items"), headers: null, authority: "", pathname: "/items" },
            ctx,
        );
        assert.equal(badPath.status, 404);

        const missing = await facet.prepareRepresentation(
            { target: urlTarget("demo", "/items/missing"), headers: null, authority: "", pathname: "/items/missing" },
            ctx,
        );
        assert.equal(missing.status, 404);
        assert.deepEqual(deletes, ["/items/missing"]);

        const found = await facet.prepareRepresentation(
            { target: urlTarget("demo", "/items/alpha"), headers: null, authority: "", pathname: "/items/alpha" },
            ctx,
        );
        assert.deepEqual(found, { status: 200 });
        assert.equal(writes.length, 1);
        assert.equal(writes[0]?.pathname, "/items/alpha");

        deletes.length = 0;
        writes.length = 0;
        const findStmt: FindStatement = {
            op: "find",
            headers: null,
            aside: null,
            target: urlTarget("demo", "/items/*"),
            lineMarker: null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        };
        const findRes = await facet.prepareFind(findStmt, ctx);
        assert.deepEqual(findRes, { status: 200 });
        assert.deepEqual(deletes, ["/items/stale-one"]);
        assert.deepEqual(writes.map((w) => w.pathname), ["/items/alpha", "/items/svc"]);

        definitions = [];
        assert.equal(invocations.length > 0, true);
    });

    test("{§resource-tree-scheme} validates whole-definition editBatch and origin-aware kill (remove vs disable)", async () => {
        const invocations: Array<{ verb: string; params: unknown }> = [];
        const definitions = [
            { alias: "local", origin: "workspace" as const, state: "active" as const, definition: { v: 1 } },
            { alias: "inherited", origin: "service" as const, state: "active" as const, definition: { v: 2 } },
            { alias: "off-svc", origin: "service" as const, state: "disabled" as const, definition: { v: 3 } },
        ];
        const handle: FunctionalityFamilyHandle = {
            invoke: async (verb, params) => {
                invocations.push({ verb, params });
                if (verb === "list") return { status: 200, body: { family: "demo", definitions, offset: 0, total: definitions.length } };
                if (verb === "remove" && (params as { key?: string }).key === "missing") {
                    const problem = Problems.create("functionality", "alias-unknown", 404, "Unknown alias.", {
                        retryable: false,
                    });
                    throw Object.assign(new Error(problem.detail), { problem });
                }
                return { status: 200, body: {} };
            },
            refresh: async () => {},
        };

        const facet = new FunctionalityResourceFacet({
            owner: "demo:resource",
            scheme: "demo",
            handle: () => handle,
            manifest: { writableBy: ["model", "client"] },
            claims: () => true,
            aliasFromPathname: (pathname) => {
                const raw = pathname.replace(/^\//u, "");
                return raw.length === 0 ? null : raw;
            },
            pathnameOfAlias: (alias) => `/${alias}`,
            authorityDetail: "Demo resources use an empty authority.",
            notFoundDetail: "The demo resource does not exist.",
            wholeEditDetail: "One edit sets one demo definition, whole.",
            wholeKillDetail: "kill retires the whole demo definition.",
            toEditInvocation: FunctionalityResourceFacet.jsonReplaceInvocation(
                "demo:resource",
                "The demo definition body must be a JSON object.",
            ),
            selectParams: (alias) => ({ key: alias }),
        });

        const { ctx, deletes } = createMockCtx();

        const edit = (target: ParsedPath | null, body: string | null, scoped = false): ResolvedEditStatement => ({
            op: "edit",
            headers: null,
            aside: null,
            target,
            lineMarker: scoped ? { marks: [1, 2] } : null,
            matcher: null,
            body,
            position: UNKNOWN_POSITION,
        });

        assert.equal((await facet.editBatch([], ctx)).status, 400);
        assert.equal((await facet.editBatch([edit(urlTarget("demo", "/local"), "{}", true)], ctx)).status, 400);
        assert.equal((await facet.editBatch([edit(urlTarget("demo", "/local", "bad"), "{}")], ctx)).status, 400);
        assert.equal((await facet.editBatch([edit(urlTarget("demo", "/"), "{}")], ctx)).status, 404);
        assert.equal((await facet.editBatch([edit(urlTarget("demo", "/local"), "not-json")], ctx)).status, 400);
        assert.equal((await facet.editBatch([edit(urlTarget("demo", "/local"), "[]")], ctx)).status, 400);

        const okEdit = await facet.editBatch([edit(urlTarget("demo", "/local"), '{"v":9}')], ctx);
        assert.deepEqual(okEdit, { status: 200 });
        assert.deepEqual(invocations.at(-1), { verb: "replace", params: { v: 9, alias: "local" } });
        assert.deepEqual(deletes, ["/local"]);

        const kill = (target: ParsedPath | null, scoped = false): KillStatement => ({
            op: "kill",
            headers: null,
            remote: null,
            aside: null,
            target,
            lineMarker: scoped ? { marks: [1, 2] } : null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        });

        assert.equal((await facet.kill(kill(urlTarget("demo", "/local"), true), ctx)).status, 400);
        assert.equal((await facet.kill(kill(null), ctx)).status, 400);

        // Workspace-owned -> remove
        const killLocal = await facet.kill(kill(urlTarget("demo", "/local")), ctx);
        assert.deepEqual(killLocal, { status: 200 });
        assert.deepEqual(invocations.at(-1), { verb: "remove", params: { key: "local" } });

        // Service-owned active -> disable
        const killSvc = await facet.kill(kill(urlTarget("demo", "/inherited")), ctx);
        assert.deepEqual(killSvc, { status: 200 });
        assert.deepEqual(invocations.at(-1), { verb: "disable", params: { key: "inherited" } });

        // Service-owned already disabled -> 404
        const killOffSvc = await facet.kill(kill(urlTarget("demo", "/off-svc")), ctx);
        assert.equal(killOffSvc.status, 404);

        // Missing -> remove -> Problem 404 propagated
        const killMissing = await facet.kill(kill(urlTarget("demo", "/missing")), ctx);
        assert.equal(killMissing.status, 404);

        // Unattached handle throws internal error
        const unattached = new FunctionalityResourceFacet({
            owner: "demo:resource",
            scheme: "demo",
            handle: () => null,
            manifest: { writableBy: ["model"] },
            claims: () => true,
            aliasFromPathname: (p) => p.slice(1) || null,
            pathnameOfAlias: (a) => `/${a}`,
            authorityDetail: "Empty authority.",
            notFoundDetail: "Not found.",
            wholeEditDetail: "Whole edit.",
            wholeKillDetail: "Whole kill.",
            toEditInvocation: (alias) => ({ verb: "replace", params: { alias } }),
        });
        await assert.rejects(
            () =>
                unattached.prepareRepresentation(
                    { target: urlTarget("demo", "/x"), headers: null, authority: "", pathname: "/x" },
                    ctx,
                ),
            /demo family is not attached/u,
        );
    });
});
