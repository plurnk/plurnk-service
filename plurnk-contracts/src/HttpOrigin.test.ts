import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialAuthority } from "./Application.ts";
import { admitBearerRequest } from "./HttpOrigin.ts";

const makeAuthority = (issuer: string | null): CredentialAuthority => ({
    operatorSecret: null,
    issue: () => ({ token: "tok", expiresAt: 0 }),
    verify: (token) => {
        if (token === "notifications-tok") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["notifications"],
                family: "fam-n",
                expiresAt: 9_999_999_999_999,
            };
        }
        if (token === "acp-tok") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["acp"],
                family: "fam-a",
                expiresAt: 9_999_999_999_999,
            };
        }
        if (token === "mcp-tok") {
            return {
                kind: "access",
                subject: "operator",
                clientId: "cli",
                scopes: ["mcp"],
                family: "fam-m",
                expiresAt: 9_999_999_999_999,
            };
        }
        return null;
    },
    consume: () => ({ reusedFamily: null }),
    revokeFamily: () => {},
    onRevoked: () => () => {},
    sessions: () => [],
    registerClient: (c) => ({ clientId: c.id, clientSecret: "secret" }),
    client: () => null,
    authenticateClient: () => false,
    publish: () => {},
    face: () => (issuer === null ? null : { issuer: () => issuer }),
});

test("{§credential-authority} {§http-host} admitBearerRequest names requiredScope and acceptedScopes on 403 insufficient_scope", () => {
    const credentials = makeAuthority("https://plurnk.example.com");

    const admittedNotifications = admitBearerRequest(
        credentials,
        { headers: { authorization: "Bearer notifications-tok" } },
        {
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
            requiredScope: "notifications",
            acceptedScopes: ["notifications", "acp"],
        },
    );
    assert.deepEqual(admittedNotifications, { ok: true, family: "fam-n", subject: "operator" });

    const admittedAcp = admitBearerRequest(
        credentials,
        { headers: { authorization: "Bearer acp-tok" } },
        {
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
            requiredScope: "notifications",
            acceptedScopes: ["notifications", "acp"],
        },
    );
    assert.deepEqual(admittedAcp, { ok: true, family: "fam-a", subject: "operator" });

    const rejectedMcp = admitBearerRequest(
        credentials,
        { headers: { authorization: "Bearer mcp-tok" } },
        {
            domain: "daemon:notifications",
            codePrefix: "daemon/notifications",
            requiredScope: "notifications",
            acceptedScopes: ["notifications", "acp"],
        },
    );
    assert.equal(rejectedMcp.ok, false);
    if (!rejectedMcp.ok) {
        assert.equal(
            rejectedMcp.challenge,
            'Bearer realm="plurnk", error="insufficient_scope", scope="notifications", resource_metadata="https://plurnk.example.com/.well-known/oauth-protected-resource"',
        );
        assert.equal(rejectedMcp.problem.status, 403);
        assert.equal(rejectedMcp.problem.code, "daemon/notifications/bearer-scope-insufficient");
        assert.equal(rejectedMcp.problem.scope, "notifications");
        assert.deepEqual(rejectedMcp.problem.acceptedScopes, ["notifications", "acp"]);
        assert.equal(rejectedMcp.problem.detail, "The access token does not carry the scope notifications or acp.");
        assert.equal(rejectedMcp.problem.recovery, "Obtain an access token with the scope notifications or acp.");
    }

    const rejectedSingle = admitBearerRequest(
        credentials,
        { headers: { authorization: "Bearer mcp-tok" } },
        {
            domain: "acp:http",
            codePrefix: "acp/http",
            requiredScope: "acp",
        },
    );
    assert.equal(rejectedSingle.ok, false);
    if (!rejectedSingle.ok) {
        assert.match(rejectedSingle.challenge, /error="insufficient_scope", scope="acp"/u);
        assert.equal(rejectedSingle.problem.scope, "acp");
        assert.equal("acceptedScopes" in rejectedSingle.problem, false);
        assert.equal(rejectedSingle.problem.detail, "The access token does not carry the scope acp.");
        assert.equal(rejectedSingle.problem.recovery, "Obtain an access token with the scope acp.");
    }
});
