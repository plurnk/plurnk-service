// {§module-discovery} — a daemon with nothing registered composes the installed default modules
// by discovery alone, as the service does.
import assert from "node:assert/strict";
import test from "node:test";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";

const VERBS = ["add", "disable", "discover", "enable", "list", "remove"];

test("{§mcp-module} {§schedule-module} a bare daemon discovers the MCP and schedule families", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const names = daemon.listModuleActions().map(({ name }) => name);
    for (const family of ["mcp", "schedule"]) {
        assert.deepEqual(
            names.filter((name) => name.startsWith(`workspace.${family}.`)).map((name) => name.slice(`workspace.${family}.`.length)).filter((verb) => VERBS.includes(verb)).toSorted(),
            VERBS,
            `the ${family} family arrives without explicit composition`,
        );
    }
});
