import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    actorsMatch,
    extractActor,
    isDefaultExteriorActor,
    parseExteriorActor,
} from "./ActorIdentity.ts";

describe("{§contract-representations} ActorIdentity", () => {
    it("{§contract-representations}: parseExteriorActor normalizes bare names and exterior URIs while refusing internal or malformed actors", () => {
        assert.deepEqual(parseExteriorActor("hazool17"), {
            name: "hazool17",
            scheme: "acp",
            uri: "acp://hazool17",
        });
        assert.deepEqual(parseExteriorActor("scoutproxy", "mcp"), {
            name: "scoutproxy",
            scheme: "mcp",
            uri: "mcp://scoutproxy",
        });
        assert.deepEqual(parseExteriorActor("acp://AngryJessieLou625"), {
            name: "AngryJessieLou625",
            scheme: "acp",
            uri: "acp://AngryJessieLou625",
        });
        assert.deepEqual(parseExteriorActor("mcp://bridge-1/", "acp"), {
            name: "bridge-1",
            scheme: "mcp",
            uri: "mcp://bridge-1",
        });
        assert.deepEqual(parseExteriorActor("auth0|507f1f77"), {
            name: "auth0|507f1f77",
            scheme: "acp",
            uri: "acp://auth0%7C507f1f77",
        });

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
        ]) {
            assert.equal(parseExteriorActor(bad), null, `expected '${bad}' to be rejected`);
        }
    });

    it("{§contract-representations}: actorsMatch compares normalized exterior principals across bare and URI spellings", () => {
        assert.equal(actorsMatch("scoutproxy", "scoutproxy"), true);
        assert.equal(actorsMatch("acp://scoutproxy", "scoutproxy"), true);
        assert.equal(actorsMatch("mcp://scoutproxy", "acp://scoutproxy"), true);
        assert.equal(actorsMatch("auth0|123", "auth0|123"), true);
        assert.equal(actorsMatch("acp://auth0%7C123", "auth0|123"), true);
        assert.equal(actorsMatch("hazool17", "scoutproxy"), false);
        assert.equal(actorsMatch("", "scoutproxy"), false);
    });

    it("{§contract-representations}: extractActor extracts non-default exterior and session actors uniformly", () => {
        assert.equal(extractActor("acp://hazool17/sessions/1%23gookie/messages/m1"), "hazool17");
        assert.equal(extractActor("acp://hazool17"), "hazool17");
        assert.equal(extractActor("acp://auth0%7C123/sessions/1%23main/messages/m1"), "auth0|123");
        assert.equal(extractActor("mcp://bridge-1"), "bridge-1");
        assert.equal(extractActor("session://worker"), "worker");
        assert.equal(extractActor("message://gookie/scoutproxy_00"), "scoutproxy");
        assert.equal(extractActor("message://gookie/auth0%7C123_01"), "auth0|123");

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
        ]) {
            assert.equal(extractActor(omitted), undefined, `expected '${String(omitted)}' to yield undefined`);
        }
        assert.equal(isDefaultExteriorActor("operator"), true);
        assert.equal(isDefaultExteriorActor("client"), true);
        assert.equal(isDefaultExteriorActor("hazool17"), false);
    });
});
