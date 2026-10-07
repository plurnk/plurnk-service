import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { output, readJson, writeJson } from "./release-candidate.mjs";
import { probeInstalledDaemon } from "./release-daemon-probe.mjs";

// The same named graph is installed from archives before publication and from npm afterwards.
export const verifyConsumer = async (records, { directory, evidence, registry = false }) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "plurnk-release-consumer-"));
    try {
        await writeJson(path.join(cwd, "package.json"), { name: "release-consumer", private: true, version: "1.0.0" });
        const specs = records.map(({ name, version, archive }) => registry ? `${name}@${version}` : path.join(directory, archive));
        await output("npm", ["install", "--no-audit", "--no-fund", ...specs], cwd);
        await output("npm", ["ls", "--all"], cwd);
        for (const { name, version } of records) {
            const installed = await readJson(path.join(cwd, "node_modules", name, "package.json"));
            if (installed.version !== version) throw new Error(`${name}: consumer installed ${installed.version}, expected ${version}`);
        }
        const service = records.find(({ name }) => name === "@plurnk/plurnk-service");
        if (service !== undefined) {
            const home = path.join(cwd, "home");
            await mkdir(home);
            const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PLURNK_")));
            await probeInstalledDaemon({
                command: path.join(cwd, "node_modules", ".bin", "plurnk-service"), cwd,
                env: {
                    ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
                    XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"),
                    XDG_CACHE_HOME: path.join(home, ".cache"),
                    OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "none",
                },
                packageName: service.name, version: service.version,
            });
        }
        const client = records.find(({ name }) => name === "@plurnk/plurnk");
        if (client !== undefined) {
            // Reuse the client-owned CLI/AG-UI journeys against this installed graph.
            await output(process.execPath, [path.join(client.root, "scripts/test-composition.mjs"), "--installed", cwd], client.root);
        }
        if (evidence !== undefined) await cp(path.join(cwd, "package-lock.json"), evidence);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
};
