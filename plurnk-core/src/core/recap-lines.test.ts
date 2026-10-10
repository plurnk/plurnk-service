import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { recapLines } from "./recap-lines.ts";
import PacketWire from "./packet-wire.ts";

test("{§recap-lines} lines render in alias order, each in its directive's callout, ahead of the source", () => {
    const lines = recapLines({
        PLURNK_SERVICE_RECAP_LINE_b: "YOU MAY read while reasoning.",
        PLURNK_SERVICE_RECAP_LINE_a: "YOU MUST begin with a NOTE.",
        PLURNK_SERVICE_RECAP_LINE_c: "",
    });
    assert.deepEqual(lines, ["YOU MUST begin with a NOTE.", "YOU MAY read while reasoning."], "alias order; an empty value is a line turned off");
    assert.equal(PacketWire.renderRecap(lines, "Plugin recap."),
        "> [!IMPORTANT]\n> YOU MUST begin with a NOTE.\n\n> [!TIP]\n> YOU MAY read while reasoning.\n\nPlugin recap.");
    assert.equal(PacketWire.renderRecap([], ""), "", "no lines and an empty source omit the footer");
});

test("{§recap-lines} a line that opens with no directive is a configuration error naming its key", () => {
    assert.throws(() => recapLines({ PLURNK_SERVICE_RECAP_LINE_x: "Remember to take notes." }),
        (error: unknown) => error instanceof ConfigurationError && /PLURNK_SERVICE_RECAP_LINE_x/u.test(error.message));
});
