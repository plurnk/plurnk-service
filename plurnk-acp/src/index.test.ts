import assert from "node:assert/strict";
import test from "node:test";
import createDaemonModule from "./daemon-module.ts";
import AcpDefault, { Module, SessionTranslator, terminalIdForEntry } from "./index.ts";

test("{§acp-daemon-client} package root and daemon-module export Module, SessionTranslator, and terminalIdForEntry", () => {
    assert.equal(AcpDefault, Module);
    assert.equal(typeof SessionTranslator, "function");
    assert.equal(terminalIdForEntry(42), "term:42");
    assert.ok(createDaemonModule() instanceof Module);
});
