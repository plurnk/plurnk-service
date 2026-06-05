// Demos that require the model to run shell commands to answer
// correctly. Natural prompts — no syntax hints, no mention of EXEC,
// no exec:// references. The model has to recognize from plurnk.md's
// sysprompt that EXEC is the right tool.
//
// Each task asks for a specific factual value the model genuinely
// can't know without running something (machine state, filesystem
// contents). Holistic outcome assertions: the model's final reply
// matches the actual shell output.

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { PATHS } from "../../src/index.ts";
import Yolo from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");
const PERSONA = await readFile(PATHS.defaultPersona, "utf8");
const REQUIREMENTS = await readFile(PATHS.defaultRequirements, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; demo tests require a configured model alias");
    const provider = await ProviderInstantiate.loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

const lastTurnContent = async (db: Db, turnId: number): Promise<string> => {
    const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

interface DemoOpts {
    label: string;
    prompt: string;       // NATURAL prompt — no tool hints
    expected: RegExp;     // final reply must match
}

const runShellDemo = async ({ label, prompt, expected }: DemoOpts): Promise<void> => {
    const provider = await buildProvider();
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
        Yolo.attachYolo(engine, db);
        const sessionId = await insertSession(db, `demo-${label}-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, prompt);
        await (db.engine_set_loop_flags as PrepMethod).run({
            loop_id: loopId, flags: JSON.stringify({ yolo: true }),
        });

        const result = await engine.runLoop({
            provider, sessionId, runId, loopId,
            persona: PERSONA, requirements: REQUIREMENTS,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: prompt },
            ],
        });
        await exec.idle();

        const lastTurnId = result.turnIds[result.turnIds.length - 1];
        const lastContent = lastTurnId !== undefined ? await lastTurnContent(db, lastTurnId) : "";

        if (result.finalStatus !== 200 || !expected.test(lastContent)) {
            for (const turnId of result.turnIds) {
                const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as {
                    assistant?: { content?: string };
                    system?: { index?: object[] };
                };
                console.error(`turn ${turnId} status=${row?.status}`);
                console.error(`  emission: ${(packet.assistant?.content ?? "").slice(0, 200)}`);
                console.error(`  index entries: ${(packet.system?.index ?? []).map((e: object) => {
                    const r = e as { scheme: string | null; pathname: string; channels?: Record<string, { content?: string }> };
                    const stdout = r.channels?.stdout?.content ?? "";
                    return `${r.scheme ?? "(file)"}://${r.pathname}${stdout !== "" ? ` stdout=${JSON.stringify(stdout.slice(0, 60))}` : ""}`;
                }).join("; ")}`);
            }
        }
        assert.equal(result.finalStatus, 200, "loop terminated on SEND[200]");
        assert.equal(result.hitMaxTurns, false, "didn't hit the safety cap");
        assert.match(lastContent, expected,
            `final reply contains the expected value; got: ${lastContent.slice(0, 200)}`);
    } finally { await db.close(); }
};

test("demo: 'what is the hostname of this machine?' — model uses EXEC to run hostname", async () => {
    const realHostname = execSync("hostname", { encoding: "utf8" }).trim();
    await runShellDemo({
        label: "hostname",
        prompt: "What is the hostname of this machine? Tell me exactly what your tools report.",
        expected: new RegExp(realHostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
});

test("demo: 'who am I logged in as?' — model uses EXEC to run whoami", async () => {
    const realUser = execSync("whoami", { encoding: "utf8" }).trim();
    await runShellDemo({
        label: "whoami",
        prompt: "Which user account am I logged in as on this machine?",
        expected: new RegExp(`\\b${realUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    });
});

test("demo: 'what's the current kernel release?' — model uses EXEC to run uname", async () => {
    const realKernel = execSync("uname -r", { encoding: "utf8" }).trim();
    // Stable prefix: major.minor (e.g. "6.12" from "6.12.86+deb13-amd64").
    const [maj, min] = realKernel.split(".");
    await runShellDemo({
        label: "kernel",
        prompt: "What kernel version is this machine running?",
        expected: new RegExp(`\\b${maj}\\.${min}\\b`),
    });
});
