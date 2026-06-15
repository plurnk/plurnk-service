import test from "node:test";
import assert from "node:assert/strict";
import PluginTrust from "./plugin-trust.ts";

const withGate = (value: string | undefined, fn: () => void): void => {
    const prev = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    if (value === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = value;
    try { fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        else process.env.PLURNK_PLUGINS_TRUSTED_ONLY = prev;
    }
};

test("PluginTrust: gate OFF (unset/empty/0) trusts every installed plugin — no regression (#229)", () => {
    for (const off of [undefined, "", "0"]) {
        withGate(off, () => {
            assert.equal(PluginTrust.isTrusted("@plurnk/plurnk-execs-jq"), true);
            assert.equal(PluginTrust.isTrusted("acme-execs-cobol"), true, `off=${JSON.stringify(off)} trusts third parties`);
            assert.equal(PluginTrust.isTrusted("@firewolf/firepad"), true);
        });
    }
});

test("PluginTrust: gate ON trusts @plurnk/* always + the allowlist, skips the rest (#229)", () => {
    withGate("acme-execs-cobol, @firewolf/firepad", () => {
        assert.equal(PluginTrust.isTrusted("@plurnk/plurnk-schemes-http"), true, "@plurnk is always first-party");
        assert.equal(PluginTrust.isTrusted("acme-execs-cobol"), true, "an allowlisted package is trusted");
        assert.equal(PluginTrust.isTrusted("@firewolf/firepad"), true, "the allowlist tolerates whitespace + scoped names");
        assert.equal(PluginTrust.isTrusted("evil-scheme"), false, "anything off the list is untrusted");
    });
});

test("PluginTrust: '1' is the on / zero-third-party sentinel (#229)", () => {
    withGate("1", () => {
        assert.equal(PluginTrust.isTrusted("@plurnk/plurnk-mimetypes-images"), true, "@plurnk still loads");
        assert.equal(PluginTrust.isTrusted("acme-execs-cobol"), false, "no third party loads");
    });
});
