import assert from "node:assert/strict";
import test from "node:test";
import Credentials from "./Credentials.ts";

test("{§credential-authority} Credentials starts unconfigured and delegates verification to a single published CredentialFace", async () => {
    const authority = new Credentials();
    assert.equal(authority.face(), null);
    assert.equal(await authority.verify("any-token"), null);

    authority.publish({
        issuer: (req) => `https://${typeof req?.headers.host === "string" ? req.headers.host : "plurnk.example.com"}`,
        verify: async (token) =>
            token === "valid-jwt"
                ? { subject: "alice", email: "alice@example.com", scopes: ["openid"], expiresAt: 1_900_000_000_000 }
                : null,
    });

    assert.equal(authority.face()?.issuer(), "https://plurnk.example.com");
    assert.equal(authority.face()?.issuer({ headers: { host: "local.example.com" } }), "https://local.example.com");
    assert.deepEqual(await authority.verify("valid-jwt"), {
        subject: "alice",
        email: "alice@example.com",
        scopes: ["openid"],
        expiresAt: 1_900_000_000_000,
    });
    assert.equal(await authority.verify("invalid"), null);
    assert.equal(await authority.verify("   "), null);

    assert.throws(
        () => authority.publish({ issuer: () => "https://second.example.com", verify: () => null }),
        /already published/u,
    );
});
