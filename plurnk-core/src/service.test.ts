import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HostPaths from "./core/HostPaths.ts";
import OperatorConfig from "./core/OperatorConfig.ts";
import Paths from "./Paths.ts";
import Service from "./service.ts";

describe("Service config and credential diagnostics", () => {
    test("{§installation} {§operator-config-precedence} systemd unit inspection: system-only, user-only, both-installed, and neither-installed shapes", () => {
        const userUnitPath = "/home/tay/.config/systemd/user/plurnk.service";
        const systemUnitPath = "/etc/systemd/system/plurnk.service";

        // 1. Only a system unit is installed and owns the running daemon.
        const systemOnly = Service.inspectSystemdUnits({
            userUnitPath,
            systemUnitPath,
            daemonPid: 35812,
            exists: (path) => path === systemUnitPath,
            probe: (scope) => scope === "system"
                ? { activeState: "active", subState: "running", mainPid: 35812 }
                : null,
        });
        const systemOnlyLines = Service.formatSystemdLines(systemOnly, 35812);
        assert.deepEqual(systemOnlyLines, [
            `systemd system unit: ${systemUnitPath} (active (running), main pid 35812, owns daemon)`,
        ]);
        assert.equal(systemOnlyLines.some((line) => line.includes("user unit")), false);

        // 2. Only a user unit is installed and owns the running daemon.
        const userOnly = Service.inspectSystemdUnits({
            userUnitPath,
            systemUnitPath,
            daemonPid: 4100,
            exists: (path) => path === userUnitPath,
            probe: (scope) => scope === "user"
                ? { activeState: "active", subState: "running", mainPid: 4100 }
                : null,
        });
        const userOnlyLines = Service.formatSystemdLines(userOnly, 4100);
        assert.deepEqual(userOnlyLines, [
            `systemd user unit: ${userUnitPath} (active (running), main pid 4100, owns daemon)`,
        ]);
        assert.equal(userOnlyLines.some((line) => line.includes("system unit")), false);

        // 3. Both user and system units are installed; disambiguates which owns the daemon.
        const bothInstalled = Service.inspectSystemdUnits({
            userUnitPath,
            systemUnitPath,
            daemonPid: 35812,
            exists: () => true,
            probe: (scope) => scope === "system"
                ? { activeState: "active", subState: "running", mainPid: 35812 }
                : { activeState: "inactive", subState: "dead" },
        });
        const bothLines = Service.formatSystemdLines(bothInstalled, 35812);
        assert.deepEqual(bothLines, [
            `systemd user unit: ${userUnitPath} (inactive (dead), does not own daemon)`,
            `systemd system unit: ${systemUnitPath} (active (running), main pid 35812, owns daemon)`,
        ]);

        // 4. Neither unit is installed.
        const neither = Service.inspectSystemdUnits({
            userUnitPath,
            systemUnitPath,
            daemonPid: null,
            exists: () => false,
            probe: () => null,
        });
        assert.deepEqual(Service.formatSystemdLines(neither, null), ["systemd: no unit installed"]);
    });

    test("{§installation} {§operator-config-precedence} assertRouteReady names missing provider credentials and passes when present", () => {
        assert.throws(
            () => Service.assertRouteReady({ provider: "deepseek", model: "deepseek-v4-flash" }, {}, "PLURNK_MODEL"),
            (cause: unknown) => {
                assert.ok(cause instanceof Error);
                assert.match(cause.message, /PLURNK_MODEL selects deepseek\/deepseek-v4-flash/);
                assert.match(cause.message, /DEEPSEEK_API_KEY/);
                return true;
            },
        );
        assert.doesNotThrow(() =>
            Service.assertRouteReady(
                { provider: "deepseek", model: "deepseek-v4-flash" },
                { DEEPSEEK_API_KEY: "sk-live-secret" },
                "PLURNK_MODEL",
            ),
        );
        assert.throws(
            () => Service.assertRouteReady(
                { alias: "cloud", provider: "openrouter", model: "qwen/qwen3-coder" },
                {},
                "PLURNK_MODEL_CHILD",
            ),
            /PLURNK_MODEL_CHILD selects cloud \(openrouter\/qwen\/qwen3-coder\), which requires OPENROUTER_API_KEY/,
        );
    });

    test("{§installation} {§operator-config-precedence} staleOperatorFiles and formatRestartRequired detect operator file edits after daemon start", () => {
        const configFile = "/home/tay/.config/plurnk/.env";
        const localConfigFile = "/home/tay/.config/plurnk/.env.local";
        const status = { pid: 35812, startedAt: 1_700_000_000_000 };

        const stale = Service.staleOperatorFiles(
            status,
            [configFile, localConfigFile],
            (path) => path === configFile ? 1_700_000_060_000 : 1_699_999_000_000,
        );
        assert.deepEqual(stale, [configFile]);
        const message = Service.formatRestartRequired(status, stale, false);
        assert.ok(message !== null);
        assert.match(message, /restart required/);
        assert.ok(message.includes(configFile));
        assert.ok(message.includes("35812"));

        const fresh = Service.staleOperatorFiles(
            status,
            [configFile, localConfigFile],
            () => 1_699_999_000_000,
        );
        assert.deepEqual(fresh, []);
        assert.equal(Service.formatRestartRequired(status, fresh, false), null);
    });

    test("{§installation} {§operator-config-precedence} detectCredentialDrift catches shell-vs-file divergence without printing secret values", () => {
        const configFile = "/home/tay/.config/plurnk/.env";
        const shellSecret = "sk-shell-rotated-value-never-print";
        const fileSecret = "sk-file-stale-value-never-print";

        // Disagree: fails naming the variable and both sources, never the values.
        const disagree = Service.detectCredentialDrift(
            { DEEPSEEK_API_KEY: shellSecret },
            [{ path: configFile, content: `DEEPSEEK_API_KEY="${fileSecret}"\nPLURNK_MODEL=deepseek/deepseek-v4-flash\n` }],
            {},
        );
        assert.equal(disagree.length, 1);
        assert.equal(disagree[0].key, "DEEPSEEK_API_KEY");
        assert.match(disagree[0].message, /DEEPSEEK_API_KEY/);
        assert.match(disagree[0].message, /process environment/);
        assert.ok(disagree[0].message.includes(configFile));
        assert.equal(disagree[0].message.includes(shellSecret), false);
        assert.equal(disagree[0].message.includes(fileSecret), false);

        // Agree: zero drift errors.
        const agree = Service.detectCredentialDrift(
            { DEEPSEEK_API_KEY: shellSecret },
            [{ path: configFile, content: `DEEPSEEK_API_KEY="${shellSecret}"\n` }],
            {},
        );
        assert.deepEqual(agree, []);

        // Absent in one or both: zero drift errors.
        assert.deepEqual(
            Service.detectCredentialDrift(
                { DEEPSEEK_API_KEY: shellSecret },
                [{ path: configFile, content: "PLURNK_MODEL=deepseek/deepseek-v4-flash\n" }],
                {},
            ),
            [],
        );
        assert.deepEqual(
            Service.detectCredentialDrift(
                {},
                [{ path: configFile, content: `DEEPSEEK_API_KEY="${fileSecret}"\n` }],
                {},
            ),
            [],
        );
    });

    test("{§installation} {§credential-authority} {§operator-config-precedence} OperatorConfig never copies ambient credentials into the seeded config directory", async () => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-no-credential-copy-"));
        const ambientSecret = "sk-ambient-secret-must-never-be-written";
        const prior = process.env.DEEPSEEK_API_KEY;
        process.env.DEEPSEEK_API_KEY = ambientSecret;
        try {
            const paths = new HostPaths({ env: { DEEPSEEK_API_KEY: ambientSecret }, home: join(root, "home") });
            assert.equal(await OperatorConfig.ensure(paths, Paths.policy), true);
            const entries = await readdir(paths.configDir);
            for (const entry of entries) {
                const text = await readFile(join(paths.configDir, entry), "utf8");
                assert.equal(text.includes(ambientSecret), false, `${entry} must not contain ambient credentials`);
            }
        } finally {
            if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
            else process.env.DEEPSEEK_API_KEY = prior;
            await rm(root, { recursive: true, force: true });
        }
    });
});
