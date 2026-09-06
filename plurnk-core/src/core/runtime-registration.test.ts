import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import type { Db } from "./Db.ts";
import Engine from "./Engine.ts";
import ExecutorRegistry, {
    type Executor,
    type RegistryEntry,
} from "./ExecutorRegistry.ts";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { SchemeManifest } from "./scheme-types.ts";

const invocation: RuntimeInvocationDecl = {
    body: { role: "input", required: true },
    example: { body: "example" },
};

const manifest = (name: string): SchemeManifest => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data",
    entryOwner: "commons",
    inherit: "none",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
});

const executor = (tag: string): Executor => ({
    runtime: tag,
    glyph: "",
    manifest: manifest(tag),
    defaultChannel: "body",
    channels: { body: { mimetype: "text/plain" } },
    run: async () => ({ status: 200 }),
    probe: async () => ({ available: true }),
    effect: () => "read",
});

const registration = (tag: string): {
    tag: string;
    entry: RegistryEntry;
} => ({
    tag,
    entry: {
        executor: executor(tag),
        namespaceOwner: { kind: "module", name: "@acme/module" },
        glyph: "",
        summary: `${tag} fixture.`,
        invocation,
        details: "",
        available: true,
        detail: undefined,
    },
});

test("{§plugin-namespace-arbitration} runtime batches publish neither registry when one scheme claim collides", () => {
    const schemes = new SchemeRegistry();
    schemes.register("beta", { manifest: manifest("beta") });
    const executors = new ExecutorRegistry(new Map());
    const engine = new Engine({ db: {} as Db, schemes });
    engine.setExecutors(executors);

    assert.throws(
        () => engine.registerRuntimes([
            registration("alpha"),
            registration("beta"),
        ]),
        /scheme name 'beta'.*programmatic scheme 'beta'.*daemon module runtime '@acme\/module'/,
    );

    assert.equal(executors.entry("alpha"), undefined);
    assert.equal(executors.entry("beta"), undefined);
    assert.equal(schemes.has("alpha"), false);
});

test("{§executor-policy} module runtimes share package discovery's executor switches", async (t) => {
    const keys = ["PLURNK_EXECS_ONLY", "PLURNK_EXECS_BETA", "plurnk_execs_beta"];
    const previous = keys.map((key) => [key, process.env[key]] as const);
    const cases: Array<{ env: Record<string, string>; expected: string[] }> = [
        { env: {}, expected: ["alpha", "beta"] },
        { env: { PLURNK_EXECS_BETA: "0" }, expected: ["alpha"] },
        { env: { plurnk_execs_beta: "FaLsE" }, expected: ["alpha"] },
        { env: { PLURNK_EXECS_ONLY: "ALPHA", PLURNK_EXECS_BETA: "1" }, expected: ["alpha"] },
        { env: { PLURNK_EXECS_ONLY: "alpha,beta", PLURNK_EXECS_BETA: "0" }, expected: ["alpha"] },
        { env: { PLURNK_EXECS_ONLY: "" }, expected: [] },
    ];
    try {
        for (const workerId of [undefined, 1]) {
            for (const { env, expected } of cases) {
                await t.test(`${workerId === undefined ? "daemon" : "worker"}: ${JSON.stringify(env)}`, async () => {
                    for (const key of keys) delete process.env[key];
                    Object.assign(process.env, env);
                    const schemes = new SchemeRegistry();
                    const executors = new ExecutorRegistry(new Map());
                    const engine = new Engine({ db: {} as Db, schemes });
                    engine.setExecutors(executors);
                    const registrations = [registration("alpha"), registration("beta")];
                    if (workerId === undefined) engine.registerRuntimes(registrations);
                    else (await engine.prepareWorkerRuntimes(workerId, "@acme/module", registrations))();
                    for (const tag of ["alpha", "beta"]) {
                        assert.equal(executors.entry(tag, workerId) !== undefined, expected.includes(tag), `${tag} executor`);
                        assert.equal(schemes.has(tag, workerId), expected.includes(tag), `${tag} scheme`);
                    }
                });
            }
        }
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
