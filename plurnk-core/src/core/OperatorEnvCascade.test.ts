import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import OperatorEnvCascade from "./OperatorEnvCascade.ts";

describe("OperatorEnvCascade", () => {
    test("{§operator-config-precedence} live reload adds, updates, and deletes operator-file keys while preserving bootEnv and CLI flags", async () => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-cascade-unit-"));
        try {
            const operatorConfigFile = join(root, ".env");
            const localConfigFile = join(root, ".env.local");
            const env: NodeJS.ProcessEnv = {
                SHELL_PINNED: "from-shell",
                PLURNK_SERVICE_MAX_TURNS: "7",
            };
            const defaultsMap = new Map<string, { value: string; owner: string }>([
                ["PLURNK_PORT", { value: "1066", owner: "@plurnk/plurnk-contracts" }],
                ["PLURNK_SERVICE_MAX_TURNS", { value: "-1", owner: "@plurnk/plurnk-service" }],
                ["PLURNK_SERVICE_MAX_STRIKES", { value: "3", owner: "@plurnk/plurnk-service" }],
            ]);
            const cliFlags = new Map([
                ["PLURNK_SERVICE_MAX_STRIKES", { value: "9", flagName: "--service-max-strikes" }],
            ]);

            const cascade = new OperatorEnvCascade({
                bootEnv: { SHELL_PINNED: "from-shell" },
                cliFlags,
                envFiles: [],
                configFile: null,
                localConfigFile,
                operatorConfigFile,
                defaultsMap,
                declares: (key) => defaultsMap.has(key) || key.startsWith("PLURNK_MODEL"),
                env,
            });

            const first = cascade.refreshIfChanged({ force: true });
            assert.equal(first.changed, true);
            assert.equal(env.PLURNK_SERVICE_MAX_TURNS, "-1");
            assert.equal(env.PLURNK_SERVICE_MAX_STRIKES, "9");
            assert.equal(env.SHELL_PINNED, "from-shell");
            assert.equal(cascade.refreshIfChanged().changed, false);

            cascade.pinBindTimeValues();

            await writeFile(
                operatorConfigFile,
                [
                    "SHELL_PINNED=from-dotenv",
                    "PLURNK_SERVICE_MAX_TURNS=12",
                    "PLURNK_SERVICE_MAX_STRIKES=1",
                    "PLURNK_MODEL_fast=openai/gpt-5",
                    "PLURNK_MODEL=fast",
                    "OPENAI_API_KEY=sk-test",
                    "",
                ].join("\n"),
                "utf8",
            );

            const second = cascade.refreshIfChanged();
            assert.equal(second.changed, true);
            assert.equal(env.SHELL_PINNED, "from-shell", "bootEnv outranks .env");
            assert.equal(env.PLURNK_SERVICE_MAX_STRIKES, "9", "CLI flag outranks .env");
            assert.equal(env.PLURNK_SERVICE_MAX_TURNS, "12", ".env overrides .env.defaults");
            assert.equal(env.PLURNK_MODEL_fast, "openai/gpt-5");
            assert.equal(env.PLURNK_MODEL, "fast");
            assert.equal(env.OPENAI_API_KEY, "sk-test");
            assert.deepEqual(second.restartRequired, []);

            // Delete keys from .env and edit bind-time PLURNK_PORT.
            await writeFile(
                operatorConfigFile,
                "PLURNK_PORT=2048\n",
                "utf8",
            );

            const third = cascade.refreshIfChanged();
            assert.equal(third.changed, true);
            assert.equal(env.PLURNK_SERVICE_MAX_TURNS, "-1", "deleted .env key reverts to .env.defaults");
            assert.equal(env.PLURNK_MODEL_fast, undefined, "deleted custom key is removed from env");
            assert.equal(env.PLURNK_MODEL, undefined);
            assert.equal(env.OPENAI_API_KEY, undefined);
            assert.equal(env.SHELL_PINNED, "from-shell", "bootEnv remains untouched");
            assert.equal(env.PLURNK_PORT, "1066", "bind-time key stays pinned in running daemon");
            assert.equal(third.restartRequired.length, 1);
            assert.equal(third.restartRequired[0].key, "PLURNK_PORT");
            assert.match(third.restartRequired[0].message, /PLURNK_PORT changed in .*\.env; restart the daemon to apply\./);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("{§configuration-repair-path} {§operator-config-precedence} malformed live .env entries are contained without crashing", async () => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-cascade-malformed-"));
        try {
            const operatorConfigFile = join(root, ".env");
            const localConfigFile = join(root, ".env.local");
            const env: NodeJS.ProcessEnv = {};
            const cascade = new OperatorEnvCascade({
                bootEnv: {},
                cliFlags: new Map(),
                envFiles: [],
                configFile: null,
                localConfigFile,
                operatorConfigFile,
                defaultsMap: new Map([["PLURNK_PORT", { value: "1066", owner: "@plurnk/plurnk-contracts" }]]),
                declares: () => true,
                env,
            });
            cascade.refreshIfChanged({ force: true });
            await writeFile(operatorConfigFile, "NOT A VALID KEY=oops\nVALID_KEY=ok\n", "utf8");
            const reloaded = cascade.refreshIfChanged();
            assert.equal(reloaded.changed, true);
            assert.equal(env.VALID_KEY, "ok");
            assert.equal(env["NOT A VALID KEY"], undefined);
            assert.equal(reloaded.parseErrors.length, 1);
            assert.match(reloaded.parseErrors[0].message, /Malformed environment entry/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
