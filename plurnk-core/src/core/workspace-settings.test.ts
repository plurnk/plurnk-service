import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WorkspaceSettings from "./workspace-settings.ts";

const withDocsEnv = async <T>(
    values: Readonly<Record<string, string>>,
    run: () => Promise<T>,
): Promise<T> => {
    const prefix = "PLURNK_SERVICE_MD_";
    const previous = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith(prefix)));
    for (const name of Object.keys(process.env)) {
        if (name.startsWith(prefix)) delete process.env[name];
    }
    Object.assign(process.env, values);
    try {
        return await run();
    } finally {
        for (const name of Object.keys(process.env)) {
            if (name.startsWith(prefix)) delete process.env[name];
        }
        Object.assign(process.env, previous);
    }
};

test("reference docs: unset contributes nothing; selected operator and client sources union", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reference-doc-"));
    try {
        const guide = join(root, "guide.md");
        await writeFile(guide, "# Operator guide\n", "utf8");
        await withDocsEnv({ PLURNK_SERVICE_MD_GUIDE: guide }, async () => {
            assert.deepEqual(await WorkspaceSettings.resolveDocs([]), [
                { entryName: "GUIDE.md", content: "# Operator guide\n" },
            ]);
            assert.deepEqual(await WorkspaceSettings.resolveDocs([{ alias: "REPO", content: "# Client repo\n" }]), [
                { entryName: "GUIDE.md", content: "# Operator guide\n" },
                { entryName: "REPO.md", content: "# Client repo\n" },
            ]);
        });
        await withDocsEnv({}, async () => {
            assert.deepEqual(await WorkspaceSettings.resolveDocs([]), []);
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reference docs: absent and failed selected operator reads reject with their cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reference-doc-failure-"));
    try {
        const missing = join(root, "missing.md");
        const directory = join(root, "directory.md");
        await mkdir(directory);
        for (const [path, code] of [[missing, "ENOENT"], [directory, "EISDIR"]] as const) {
            await withDocsEnv({ PLURNK_SERVICE_MD_BROKEN: path }, async () => {
                await assert.rejects(
                    () => WorkspaceSettings.resolveDocs([]),
                    (error: unknown) => {
                        assert.ok(error instanceof Error);
                        assert.match(error.message, /configured operator reference doc 'BROKEN\.md' could not be read/);
                        assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, code);
                        return true;
                    },
                );
            });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("reference docs: a client alias shadows the operator path before filesystem I/O", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reference-doc-shadow-"));
    try {
        await withDocsEnv({ PLURNK_SERVICE_MD_POLICY: join(root, "missing.md") }, async () => {
            assert.deepEqual(
                await WorkspaceSettings.resolveDocs([{ alias: "POLICY", content: "# Client policy\n" }]),
                [{ entryName: "POLICY.md", content: "# Client policy\n" }],
            );
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
