import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import StoredPacket from "../../src/core/StoredPacket.ts";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace, type LiveWorkspace } from "../_live-harness.ts";

// 128×64 RGB PNG: green left panel, purple right panel; no textual metadata.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAIAAABdtOgoAAAA3ElEQVR4nO3RwQnAABDDsBu9o7c79CECJplAvntu+t+m7wULsH0uWACPWIDhe8ECbJ8LFsAjFmD4XrAA2+eCBfCIBRi+FyzA9rlgATxiAYbvBQuwfS5YAI9YgOF7wQJsnwsWwCMWYPhesADb54IF8IgFGL4XLMD2uWABPGIBhu8FC7B9LlgAj1iA4XvBAmyfCxbAIxZg+F6wANvnggXwiAUYvhcswPa5YAE8YgGG7wULsH0uWACPWIDhe8ECbJ8LFsAjFmD4XrAA2+eCBfCIBRi+FyzA9rlgATzin7/kLQFpLxPquAAAAABJRU5ErkJggg==", "base64");
const contentHash = createHash("sha256").update(PNG).digest("hex");

const packets = async (s: LiveWorkspace, turnIds: readonly number[]) => {
    const rows = await Promise.all(turnIds.map((id) => s.db.test_get_packet.get<{ packet: string | null }>({ id })));
    return rows.flatMap((row) => {
        const packet = StoredPacket.parse(row?.packet ?? null);
        return packet === null ? [] : [packet];
    });
};

test("live: a client-attached image persists until log curation", async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-native-live-"));
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(async () => { await rm(projectRoot, { recursive: true, force: true }); });
    try {
        await writeFile(join(projectRoot, "sample.png"), PNG);
        const s = await liveWorkspace({ name: `live-native-observation-${crypto.randomUUID()}`, projectRoot });
        lifetime.defer(s.cleanup);
        if (!s.provider.inputModalities.has("image")) {
            t.skip("The selected route does not advertise native image input.");
            return;
        }
        const member = await s.invokeWorkspaceAction("workspace.members.add", {
            alias: "sample", definition: { glob: "sample.png" },
        }) as { status: number };
        assert.equal(member.status, 201);
        await s.daemon.settleFunctionality(s.workspaceId);
        assert.ok(await s.db.crud_find_workspace_entry.get({
            workspace_id: s.workspaceId, scheme: "file", authority: "", pathname: "sample.png",
        }), "the image fixture is an admitted file before any model call");

        const first = await liveLoop(s, 2, {
            prompt: "What are the two main colors in sample.png, and which is on the left?",
            openPaths: ["sample.png"],
            maxTurns: 6,
        }, { signal: t.signal });
        assert.equal(first.finalStatus, 200);
        assert.match(first.lastContent, /green/i);
        assert.match(first.lastContent, /purple|magenta/i);
        const observed = (await packets(s, first.turnIds)).flatMap((packet) => packet.attachments ?? [])
            .find((attachment) => attachment.contentHash === contentHash);
        assert.ok(observed, "the live provider received the source image, not just its textual projection");

        const followup = await liveLoop(s, 3, {
            prompt: "Using the image you just examined, are its two panels arranged horizontally or vertically?",
            maxTurns: 6,
        }, { signal: t.signal });
        assert.equal(followup.modelWorkerId, first.modelWorkerId);
        assert.equal(followup.finalStatus, 200);
        assert.match(followup.lastContent, /horizontal|side.by.side/i);
        // {§packet-attachment-parts}: the first request of another loop already contains the same observation.
        const retained = (await packets(s, followup.turnIds))[0]?.attachments ?? [];
        assert.ok(retained.some((attachment) => attachment.contentHash === contentHash && attachment.coordinate === observed.coordinate),
            "the image survives completion and the next prompt without a new READ");

        const cleanup = await liveLoop(s, 4, {
            prompt: "Remove the sample.png observation from your working log; keep the original image file untouched.",
            maxTurns: 6,
        }, { signal: t.signal });
        assert.equal(cleanup.finalStatus, 200);
        const active = await s.db.engine_render_log.all<{ op: string; rx: string }>({ worker_id: first.modelWorkerId });
        assert.equal(active.some((row) => row.op === "READ" && JSON.parse(row.rx).nativeContentHash === contentHash), false,
            "curation removes the native observation from the active log");
        assert.deepEqual(await readFile(join(projectRoot, "sample.png")), PNG, "log curation leaves the file unchanged");
        const history = await s.db.test_log_entries_by_worker_op_full.all<{ rx: string }>({ worker_id: first.modelWorkerId, op: "READ" });
        assert.ok(history.some((row) => JSON.parse(row.rx).nativeContentHash === contentHash), "immutable READ evidence survives curation");
    } finally { await lifetime.disposeAsync(); }
});
