import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    UNKNOWN_POSITION,
    type FindStatement,
    type FunctionalityFamilyHandle,
    type KillStatement,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import type { SchemeCtx } from "@plurnk/plurnk-schemes";
import McpFamilyResources from "./McpFamilyResources.ts";

const mcpUrl = (pathname: string, hostname = ""): ParsedPath => ({
    kind: "url",
    raw: `mcp://${hostname}${pathname}`,
    scheme: "mcp",
    username: null,
    password: null,
    hostname,
    port: null,
    pathname,
    query: null,
    fragment: null,
});

describe("McpFamilyResources", () => {
    test("{§mcp-module} claims server paths without shadowing .md/.json docs, materializes find, and disables service-origin servers on kill", async () => {
        const calls: Array<{ verb: string; params: unknown }> = [];
        const definitions = [
            {
                alias: "github",
                origin: "service" as const,
                state: "active" as const,
                definition: { type: "stdio", command: "mcp-github" },
            },
            {
                alias: "local",
                origin: "workspace" as const,
                state: "active" as const,
                definition: { type: "stdio", command: "mcp-local" },
            },
        ];
        const handle: FunctionalityFamilyHandle = {
            invoke: async (verb, params) => {
                calls.push({ verb, params });
                if (verb === "list") return { status: 200, body: { family: "mcp", definitions, offset: 0, total: definitions.length } };
                return { status: 200, body: {} };
            },
            refresh: async () => {},
        };
        const facet = new McpFamilyResources(() => handle);

        assert.equal(facet.claims("/servers/github"), true);
        assert.equal(facet.claims("/github"), true);
        assert.equal(facet.claims("/plurnk.md"), false);
        assert.equal(facet.claims("/plurnk.json"), false);
        assert.equal(facet.claims("/%E0%A4%A"), true);

        const writes: string[] = [];
        const deletes: string[] = [];
        const ctx = {
            workspaceId: 1,
            sessionId: 2,
            loopId: 1,
            turnId: 1,
            writer: "model",
            entries: {
                write: async (pathname: string) => {
                    writes.push(pathname);
                    return { status: 200 };
                },
                delete: async (pathname: string) => {
                    deletes.push(pathname);
                    return { status: 200 };
                },
                operations: {
                    find: async () => ({
                        status: 200,
                        results: [[{ path: "mcp:///servers/removed" }]],
                    }),
                },
            },
        } as unknown as SchemeCtx;

        const malformed = await facet.prepareRepresentation(
            { target: mcpUrl("/%E0%A4%A"), headers: null, authority: "", pathname: "/%E0%A4%A" },
            ctx,
        );
        assert.equal(malformed.status, 404);

        const findStmt: FindStatement = {
            op: "find",
            headers: null,
            aside: null,
            target: mcpUrl("/servers/*"),
            lineMarker: null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        };
        assert.deepEqual(await facet.prepareFind(findStmt, ctx), { status: 200 });
        assert.deepEqual(deletes, ["/servers/removed"]);
        assert.deepEqual(writes, ["/servers/github", "/servers/local"]);

        const killSvc: KillStatement = {
            op: "kill",
            headers: null,
            remote: null,
            aside: null,
            target: mcpUrl("/servers/github"),
            lineMarker: null,
            matcher: null,
            body: null,
            position: UNKNOWN_POSITION,
        };
        assert.deepEqual(await facet.kill(killSvc, ctx), { status: 200 });
        assert.deepEqual(calls.at(-1), { verb: "disable", params: { alias: "github" } });
    });
});
