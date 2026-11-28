import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    actorsMatch,
    extractActor,
    extractExteriorActorId,
    formatExteriorActorInput,
    isDefaultExteriorActor,
    normalizeExteriorActorProfiles,
    parseExteriorActor,
    sanitizeActorDisplayName,
    sanitizeActorHandle,
} from "./ActorIdentity.ts";

describe("{§contract-representations} ActorIdentity", () => {
    it("{§contract-representations}: parseExteriorActor normalizes bare IDs, exterior URIs, and { id, handle, name } objects while refusing internal or malformed actors", () => {
        assert.deepEqual(parseExteriorActor("hazool17"), {
            id: "hazool17",
            handle: "hazool17",
            scheme: "acp",
            uri: "acp://hazool17",
        });
        assert.deepEqual(parseExteriorActor("scoutproxy", "mcp"), {
            id: "scoutproxy",
            handle: "scoutproxy",
            scheme: "mcp",
            uri: "mcp://scoutproxy",
        });
        assert.deepEqual(parseExteriorActor("acp://AngryJessieLou625"), {
            id: "AngryJessieLou625",
            handle: "AngryJessieLou625",
            scheme: "acp",
            uri: "acp://AngryJessieLou625",
        });
        assert.deepEqual(parseExteriorActor("mcp://bridge-1/", "acp"), {
            id: "bridge-1",
            handle: "bridge-1",
            scheme: "mcp",
            uri: "mcp://bridge-1",
        });
        assert.deepEqual(parseExteriorActor("auth0|507f1f77"), {
            id: "auth0|507f1f77",
            handle: "auth0|507f1f77",
            scheme: "acp",
            uri: "acp://auth0%7C507f1f77",
        });
        assert.deepEqual(
            parseExteriorActor({ id: "auth0|507f1f77", handle: "alice", name: "Alice Smith" }),
            {
                id: "auth0|507f1f77",
                handle: "alice",
                name: "Alice Smith",
                scheme: "acp",
                uri: "acp://auth0%7C507f1f77",
            },
        );
        assert.deepEqual(
            parseExteriorActor({ id: "mcp://U12345", name: "Alice Smith" }),
            {
                id: "U12345",
                handle: "alice_smith",
                name: "Alice Smith",
                scheme: "mcp",
                uri: "mcp://U12345",
            },
        );
        assert.equal(sanitizeActorHandle("@Alice Smith", { lowercase: true }), "alice_smith");
        assert.equal(sanitizeActorHandle("operator"), undefined);
        assert.equal(sanitizeActorDisplayName("  Alice\nSmith  "), "Alice Smith");
        assert.equal(formatExteriorActorInput("alice"), "alice");
        assert.equal(formatExteriorActorInput({ id: "123" }), '{"id":"123"}');

        for (const bad of [
            "",
            "   ",
            "_plurnk",
            "acp://_plurnk",
            "mcp://_plurnk",
            ".",
            "..",
            "has space",
            "bad/path",
            "bad?query",
            "bad#frag",
            "session://worker",
            "message://gookie/00",
            "https://example.com",
            "schedule://daily",
            "acp://scoutproxy/sessions/1/messages/m1",
            "acp://user:pass@host",
            "acp://host:1066",
            "acp://%ZZ",
            null,
            [],
            {},
            { id: "" },
            { id: "123", handle: "operator" },
            { id: "123", handle: "bad handle" },
            { id: "123", unknown: "x" },
        ]) {
            assert.equal(parseExteriorActor(bad), null, `expected '${JSON.stringify(bad)}' to be rejected`);
        }
    });

    it("{§contract-representations}: actorsMatch compares normalized exterior principals across bare, URI, and object spellings", () => {
        assert.equal(actorsMatch("scoutproxy", "scoutproxy"), true);
        assert.equal(actorsMatch("acp://scoutproxy", "scoutproxy"), true);
        assert.equal(actorsMatch("mcp://scoutproxy", "acp://scoutproxy"), true);
        assert.equal(actorsMatch("auth0|123", "auth0|123"), true);
        assert.equal(actorsMatch("acp://auth0%7C123", "auth0|123"), true);
        assert.equal(actorsMatch({ id: "auth0|123", handle: "alice", name: "Alice" }, "auth0|123"), true);
        assert.equal(actorsMatch({ id: "auth0|456", handle: "alice" }, "auth0|123"), false);
        assert.equal(actorsMatch("hazool17", "scoutproxy"), false);
        assert.equal(actorsMatch("", "scoutproxy"), false);
    });

    it("{§contract-representations} {§client-session-status}: extractActor prefers actorProfile.handle and extracts non-default exterior, session, and schedule actors uniformly", () => {
        assert.equal(
            extractActor("acp://auth0%7C123/sessions/1%23main/messages/m1", { id: "auth0|123", handle: "alice" }),
            "alice",
        );
        assert.equal(extractActor("acp://hazool17/sessions/1%23gookie/messages/m1"), "hazool17");
        assert.equal(extractActor("acp://hazool17"), "hazool17");
        assert.equal(extractActor("acp://auth0%7C123/sessions/1%23main/messages/m1"), "auth0|123");
        assert.equal(extractActor("mcp://bridge-1"), "bridge-1");
        assert.equal(extractActor("session://worker"), "worker");
        assert.equal(extractActor("message://gookie/scoutproxy_00"), "scoutproxy");
        assert.equal(extractActor("message://gookie/auth0%7C123_01"), "auth0|123");
        assert.equal(extractActor("schedule:///nightly"), "nightly");
        assert.equal(extractActor("schedule:///rules/nightly"), "nightly");
        assert.equal(extractActor("schedule:///auth0%7Cbot"), "auth0|bot");

        for (const omitted of [
            null,
            undefined,
            "",
            "acp://operator/sessions/1%23main/messages/m1",
            "acp://operator",
            "acp://anonymous",
            "acp://client",
            "acp://owner",
            "mcp:///owner",
            "mcp://client",
            "mcp://owner",
            "session://_plurnk",
            "message://gookie/00",
            "message://gookie/operator_00",
            "schedule:///rules",
            "schedule:///rules/",
            "schedule:///_plurnk",
        ]) {
            assert.equal(extractActor(omitted), undefined, `expected '${String(omitted)}' to yield undefined`);
        }
        assert.equal(isDefaultExteriorActor("operator"), true);
        assert.equal(isDefaultExteriorActor("client"), true);
        assert.equal(isDefaultExteriorActor("hazool17"), false);

        assert.equal(extractExteriorActorId("acp://auth0%7C123/sessions/1%23main/messages/m1"), "auth0|123");
        assert.equal(extractExteriorActorId("mcp://tg%3A12345"), "tg:12345");
        assert.equal(extractExteriorActorId("session://worker"), undefined);
        assert.equal(extractExteriorActorId("message://room/alice_00"), undefined);
        assert.equal(extractExteriorActorId("acp://operator/sessions/1%23main/messages/m1"), undefined);

        assert.deepEqual(
            normalizeExteriorActorProfiles([
                { id: "user-123", handle: "alice", name: "Alice" },
                { id: "user-123", handle: "alice_dup" },
                { id: "operator", handle: "operator" },
                { id: "user-456", handle: "bob", name: "  " },
                null,
            ]),
            [
                { id: "user-123", handle: "alice", name: "Alice" },
                { id: "user-456", handle: "bob" },
            ],
        );
    });
});
