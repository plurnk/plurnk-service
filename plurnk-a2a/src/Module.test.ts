// {§a2a-module} — the package's one module: the outbound family always, the exposure only when its
// settings select it, and an invalid exposure setting contained ({§module-contained-configuration}).
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import type { FunctionalityFamilyHandle } from "@plurnk/plurnk-contracts";
import Module from "./Module.ts";

const floor = {
    PLURNK_A2A_ENABLED: "1",
    PLURNK_A2A_CONNECT_TIMEOUT: "30000",
    PLURNK_A2A_REQUEST_TIMEOUT: "86400000",
    PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
    PLURNK_A2A_PARENT_WORKER: "_plurnk",
    PLURNK_A2A_TOKEN: "",
};
const exposed = {
    ...floor,
    PLURNK_A2A_EXPOSE: "1", PLURNK_A2A_ENDPOINT_PATH: "/a2a",
    PLURNK_A2A_WORKSPACE: "research", PLURNK_A2A_NAME: "Research agent",
    PLURNK_A2A_DESCRIPTION: "Researches questions", PLURNK_A2A_VERSION: "1.0.0",
};

// The outbound half registers its family through the one slice it uses.
const families = async (module: Module): Promise<string[]> => {
    const registered: string[] = [];
    await module.setup({
        registerFunctionalityAdapter: (adapter) => {
            registered.push(adapter.family);
            return {} as FunctionalityFamilyHandle;
        },
    });
    return registered;
};

test("{§a2a-module} {§module-self-activation} unexposed, the module registers the outbound family and claims no mount", async () => {
    const module = Module.init(floor);
    assert.equal(module.mounts, undefined);
    assert.equal(module.contained, undefined);
    assert.deepEqual(await families(module), ["a2a"]);
});

test("{§a2a-module} exposed, the module claims the card and the endpoint beside the outbound family", async () => {
    const module = Module.init(exposed);
    assert.deepEqual(module.mounts, [`/${AGENT_CARD_PATH}`, "/a2a"]);
    assert.equal(module.contained, undefined);
    assert.deepEqual(await families(module), ["a2a"]);
});

test("{§module-contained-configuration} an invalid exposure setting withholds the exposure alone", async () => {
    for (const [key, value] of [["PLURNK_A2A_EXPOSE", "yes"], ["PLURNK_A2A_ENDPOINT_PATH", "relative"]] as const) {
        const module = Module.init({ ...exposed, [key]: value });
        assert.equal(module.mounts, undefined, `${key}: no exposure, so no mount`);
        assert.deepEqual(module.contained?.map(({ key: contained }) => contained), [key], `${key} is the contained setting`);
        assert.match(module.contained?.[0]?.message ?? "", new RegExp(key), "the message names the setting");
        assert.deepEqual(await families(module), ["a2a"], `${key}: outbound A2A still registers`);
        assert.equal(await module.start({} as Parameters<Module["start"]>[0]), undefined, "nothing starts without the exposure");
    }
});
