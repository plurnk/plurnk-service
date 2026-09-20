// {§exec-lifetime} — the four values of the one field, and what an unreadable one says.
import test from "node:test";
import assert from "node:assert/strict";
import { formatLifetime, parseExecLifetime } from "./exec-lifetime.ts";

test("{§exec-lifetime}: absent and 'loop' are the same loop-bound default", () => {
    assert.deepEqual(parseExecLifetime(undefined), {});
    assert.deepEqual(parseExecLifetime("loop"), {});
});

test("{§exec-lifetime}: a duration bounds the spawn in seconds, whatever unit it was written in", () => {
    assert.deepEqual(parseExecLifetime("45s"), { timeoutSec: 45 });
    assert.deepEqual(parseExecLifetime("30m"), { timeoutSec: 1800 });
    assert.deepEqual(parseExecLifetime("2h"), { timeoutSec: 7200 });
});

test("{§exec-lifetime}: 'turn' and 'detached' are the two named lifetimes the numbers used to carry", () => {
    assert.deepEqual(parseExecLifetime("turn"), { turnScoped: true });
    assert.deepEqual(parseExecLifetime("detached"), { detached: true });
});

test("{§exec-lifetime}: an unreadable lifetime names every form it could have taken", () => {
    for (const raw of ["30", "-1", "0", "forever", "30 m", "0m", "1d", ""]) {
        const parsed = parseExecLifetime(raw);
        assert.ok("invalid" in parsed, `'${raw}' is not a lifetime`);
        assert.match(parsed.invalid, /"30s", "30m", "2h".*"loop", "turn", or "detached"/u, raw);
    }
    const wrongType = parseExecLifetime(30);
    assert.ok("invalid" in wrongType);
    assert.match(wrongType.invalid, /A lifetime is/u);
});

test("{§exec-lifetime}: the deadline's Problem says the lifetime as it was authored", () => {
    assert.equal(formatLifetime(45), "45s");
    assert.equal(formatLifetime(1800), "30m");
    assert.equal(formatLifetime(7200), "2h");
    assert.equal(formatLifetime(90), "90s");
});
