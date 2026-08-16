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
