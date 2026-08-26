import test from "node:test";
import assert from "node:assert/strict";
import conformanceKit from "@plurnk/plurnk-contracts/conformance/agui-v1.json" with { type: "json" };
import { Validator } from "@plurnk/plurnk-contracts";
import { AGUI_BUILTIN_ACTIONS, AGUI_NOTIFICATIONS } from "./AguiSurface.ts";

test("{§agui-discovery-contract}: the AG-UI-owned executable surface is complete and schema-valid", () => {
    assert.equal(Object.keys(AGUI_BUILTIN_ACTIONS).length, 30);
    assert.equal(Object.keys(AGUI_NOTIFICATIONS).length, 10);

    for (const [name, contract] of Object.entries(AGUI_BUILTIN_ACTIONS)) {
        assert.doesNotThrow(() => Validator.validateJsonSchemaInstance(contract.inputSchema, {}), `${name} input schema compiles`);
        assert.doesNotThrow(() => Validator.validateJsonSchemaInstance(contract.outputSchema, {}), `${name} output schema compiles`);
    }
    for (const [name, contract] of Object.entries(AGUI_NOTIFICATIONS)) {
        assert.doesNotThrow(() => Validator.validateJsonSchemaInstance(contract.payloadSchema, {}), `${name} payload schema compiles`);
    }

    const discovery = Validator.assertAguiDiscovery({
        schemaVersion: 1,
        actions: AGUI_BUILTIN_ACTIONS,
        notifications: AGUI_NOTIFICATIONS,
        display: [],
    });
    assert.equal(discovery.actions["op.exec"]?.scope, "workspace");
    assert.equal(discovery.actions.ping?.scope, "worldless");
    assert.ok(discovery.notifications["loop/interaction"] !== undefined);
});

test("{§agui-action-schema-enforcement}: built-in action parameters are closed and reusable", () => {
    assert.deepEqual(
        Validator.assertJsonSchemaInstance(
            "loop.cancel input",
            AGUI_BUILTIN_ACTIONS["loop.cancel"].inputSchema,
            { reason: "user_stop" },
        ),
        { reason: "user_stop" },
    );
    assert.throws(
        () => Validator.assertJsonSchemaInstance(
            "loop.cancel input",
            AGUI_BUILTIN_ACTIONS["loop.cancel"].inputSchema,
            { reason: "user_stop", ignored: true },
        ),
        /does not satisfy its JSON Schema/,
    );
    assert.doesNotThrow(() => Validator.assertJsonSchemaInstance(
        "anonymous run.fork input",
        AGUI_BUILTIN_ACTIONS["run.fork"].inputSchema,
        {},
    ));
    assert.doesNotThrow(() => Validator.assertJsonSchemaInstance(
        "models.list input",
        AGUI_BUILTIN_ACTIONS["models.list"].inputSchema,
        { provider: "google", limit: 10 },
    ));
});

test("{§agui-conformance-kit}: every public family and named action has a shared lifecycle specimen", () => {
    const kit = Validator.assertAguiConformanceKit(conformanceKit);
    const coveredFamilies = new Set(kit.lifecycles.flatMap(({ expect }) => expect.families));
    assert.deepEqual(
        Object.keys(AGUI_NOTIFICATIONS).filter((name) => !coveredFamilies.has(name)),
        [],
        "every registered notification family has a shared lifecycle specimen",
    );
    for (const specimen of kit.lifecycles) {
        const action = specimen.expect.action;
        if (action !== undefined) {
            assert.ok(Object.hasOwn(AGUI_BUILTIN_ACTIONS, action.kind), `${action.kind} is a registered action`);
        }
    }
});
