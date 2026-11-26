#!/usr/bin/env node
// Repeatable memory footprint benchmark for built `@plurnk/plurnk-service` (`dist/`).
// Measures cold-import RSS/heap and live daemon booted / active / cooled steady-state memory (#1579).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { usage } from "./lib/usage.mjs";

usage(import.meta, `
usage: npm run bench:memory [-- --json]
Measures built dist/ RSS, heapUsed, heapTotal, and external memory across:
  1. baseline_node (bare Node process, post-GC)
  2. cold_import   (importing plurnk-core/dist/service.js, post-GC)
  3. daemon_boot   (started Daemon + migrated SQLite DB, post-GC)
  4. ws_active     (workspace created, activated, model catalog queried)
  5. ws_cooled     (workspace cooled + PRAGMA shrink_memory + GC)
Run \`npm run build\` first so dist/ reflects current source.
`);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const asJson = process.argv.includes("--json");
const mb = (bytes) => Number((bytes / (1024 * 1024)).toFixed(2));

const measureColdImport = () => {
    const serviceUrl = pathToFileURL(join(root, "plurnk-core/dist/service.js")).href;
    const script = [
        "globalThis.gc();",
        "const before = process.memoryUsage();",
        `await import(${JSON.stringify(serviceUrl)});`,
        "globalThis.gc();",
        "const after = process.memoryUsage();",
        "console.log(JSON.stringify({ before, after }));",
    ].join(" ");
    const out = execFileSync(process.execPath, [
        "--expose-gc",
        "--input-type=module",
        "-e",
        script,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(out.trim());
};

const measureDaemonLifecycle = () => {
    const scratch = mkdtempSync(join(tmpdir(), "plurnk-mem-bench-"));
    const projectDir = join(scratch, "project");
    const dbPath = join(scratch, "plurnk.db");
    try {
        const daemonUrl = pathToFileURL(join(root, "plurnk-core/dist/server/Daemon.js")).href;
        const hostPathsUrl = pathToFileURL(join(root, "plurnk-core/dist/core/HostPaths.js")).href;
        const sqlriteUrl = pathToFileURL(join(root, "node_modules/@possumtech/sqlrite/SqlRite.js")).href;
        const envDefaultsUrl = pathToFileURL(join(root, "plurnk-core/dist/core/env-defaults.js")).href;
        const sqlFunctionsUrl = pathToFileURL(join(root, "plurnk-core/dist/core/sql-functions.js")).href;
        const serviceRoot = join(root, "plurnk-core");
        const nodeModulesDir = join(root, "node_modules");
        const migrationsDir = join(root, "plurnk-core/migrations");
        const coreSqlDir = join(root, "plurnk-core/dist");
        const script = `
            import { mkdirSync, writeFileSync } from "node:fs";
            import { join } from "node:path";
            const { default: EnvDefaults } = await import(${JSON.stringify(envDefaultsUrl)});
            const files = await EnvDefaults.collect(${JSON.stringify(serviceRoot)}, ${JSON.stringify(nodeModulesDir)});
            EnvDefaults.apply(EnvDefaults.merge(files));
            process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "250";
            process.env.PLURNK_SERVICE_WORKSPACE_WARM_MAX = "1";
            process.env.PLURNK_SERVICE_STATE_ROOT = ${JSON.stringify(scratch)};
            const { default: SqlRite } = await import(${JSON.stringify(sqlriteUrl)});
            const { sqlFunctionPaths } = await import(${JSON.stringify(sqlFunctionsUrl)});
            const { default: HostPaths } = await import(${JSON.stringify(hostPathsUrl)});
            const { default: Daemon } = await import(${JSON.stringify(daemonUrl)});
            const snap = () => { globalThis.gc(); globalThis.gc(); return process.memoryUsage(); };

            mkdirSync(${JSON.stringify(projectDir)}, { recursive: true });
            for (let i = 0; i < 20; i += 1) {
                writeFileSync(join(${JSON.stringify(projectDir)}, \`file-\${i}.ts\`), \`export const value\${i} = \${i};\\n\`.repeat(40), "utf8");
            }

            const db = await SqlRite.open({
                path: ${JSON.stringify(dbPath)},
                dir: [${JSON.stringify(migrationsDir)}, ${JSON.stringify(coreSqlDir)}],
                functions: sqlFunctionPaths,
            });
            const hostPaths = new HostPaths({ home: ${JSON.stringify(scratch)}, env: process.env });
            const daemon = new Daemon({ db, hostPaths, provider: null });
            await daemon.start();
            const booted = snap();

            const { workspaceId } = await daemon.createWorkspace({ name: "bench", projectRoot: ${JSON.stringify(projectDir)} });
            await daemon.activateWorkspace({ workspaceId });
            daemon.listModels({ availability: "all", limit: 50 });
            const active = snap();

            await new Promise((done) => setTimeout(done, 450));
            const cooled = snap();

            await daemon.stop();
            await db.close();
            console.log(JSON.stringify({ booted, active, cooled }));
        `;
        const scriptFile = join(scratch, "run.mjs");
        writeFileSync(scriptFile, script, "utf8");
        const out = execFileSync(process.execPath, ["--expose-gc", scriptFile], {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env },
        });
        return JSON.parse(out.trim().split("\n").at(-1));
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

if (import.meta.main) {
    const cold = measureColdImport();
    const lifecycle = measureDaemonLifecycle();
    const report = {
        node: process.version,
        stages: {
            baseline_node: {
                rssMiB: mb(cold.before.rss),
                heapUsedMiB: mb(cold.before.heapUsed),
                externalMiB: mb(cold.before.external),
            },
            cold_import: {
                rssMiB: mb(cold.after.rss),
                heapUsedMiB: mb(cold.after.heapUsed),
                externalMiB: mb(cold.after.external),
            },
            daemon_boot: {
                rssMiB: mb(lifecycle.booted.rss),
                heapUsedMiB: mb(lifecycle.booted.heapUsed),
                externalMiB: mb(lifecycle.booted.external),
            },
            ws_active: {
                rssMiB: mb(lifecycle.active.rss),
                heapUsedMiB: mb(lifecycle.active.heapUsed),
                externalMiB: mb(lifecycle.active.external),
            },
            ws_cooled: {
                rssMiB: mb(lifecycle.cooled.rss),
                heapUsedMiB: mb(lifecycle.cooled.heapUsed),
                externalMiB: mb(lifecycle.cooled.external),
            },
        },
    };
    if (asJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
        process.stdout.write(`Memory footprint (${report.node}, built dist/, post-GC)\n`);
        process.stdout.write(`${"stage".padEnd(16)} ${"rss (MiB)".padStart(10)} ${"heapUsed (MiB)".padStart(16)} ${"external (MiB)".padStart(16)}\n`);
        for (const [name, row] of Object.entries(report.stages)) {
            process.stdout.write(
                `${name.padEnd(16)} ${String(row.rssMiB).padStart(10)} ${String(row.heapUsedMiB).padStart(16)} ${String(row.externalMiB).padStart(16)}\n`,
            );
        }
    }
}
