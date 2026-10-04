import assert from "node:assert/strict";
import test from "node:test";
import { Message, Task } from "@a2a-js/sdk";
import A2aProjection from "./A2aProjection.ts";

// {§a2a-part-resources} — the JSON channel is the protocol JSON with every raw Part's bytes replaced by
// its resource address and byte count, each under the Message or Artifact that carries it.
const withResources = (json: unknown, authority: string, resources: readonly { pathname: string }[], taskId?: string): unknown => {
    const taken = new Map<string, number>();
    const walk = (value: unknown, parent: string | null): unknown => {
        if (Array.isArray(value)) return value.map((item) => walk(item, parent));
        if (value === null || typeof value !== "object") return value;
        const record = value as Record<string, unknown>;
        const owner = typeof record.messageId === "string" ? `/messages/${record.messageId}`
            : typeof record.artifactId === "string" ? `/tasks/${taskId}/artifacts/${record.artifactId}` : parent;
        if (typeof record.raw === "string") {
            const { raw, ...rest } = record;
            const index = taken.get(owner!) ?? 0;
            taken.set(owner!, index + 1);
            const { pathname } = resources.filter((resource) => resource.pathname.startsWith(`${owner}/resources/`))[index]!;
            return { ...rest, resource: `a2a://${authority}${pathname}`, bytes: Buffer.from(raw, "base64").length };
        }
        return Object.fromEntries(Object.entries(record).map(([key, inner]) => [key, walk(inner, owner)]));
    };
    return walk(json, null);
};

test("{§a2a-part-resources}: mixed Parts preserve order, exact JSON, safe names and distinct raw sources", () => {
    const message = Message.fromJSON({
        messageId: "answer", contextId: "conversation", role: "ROLE_AGENT",
        parts: [
            { text: "First comes the explanation.", mediaType: "text/plain" },
            { raw: "AAEC", filename: "../sample.bin", mediaType: "application/octet-stream" },
            { data: { rows: [1, 2] } },
            { url: "https://example.invalid/private-file", mediaType: "image/png" },
            { raw: "/w==", filename: "../sample.bin" },
            { raw: "BAU=" },
        ],
        metadata: { provenance: "peer" },
    });
    const projected = A2aProjection.messageEntry(message, "peer");
    const body = projected.entry.channels.body!.content;
    assert.deepEqual(JSON.parse(projected.entry.channels.json!.content), withResources(Message.toJSON(message), "peer", projected.resources), "the JSON channel names each raw Part's resource and byte count, never its base64");
    assert.doesNotMatch(projected.entry.channels.json!.content, /"raw"/u);
    assert.match(body, /First comes the explanation\.[\s\S]+resources\/\.\.%2Fsample\.bin[\s\S]+"rows"[\s\S]+https:\/\/example\.invalid\/private-file/u);
    assert.equal(projected.resources.length, 3, "URL Parts are not eagerly fetched or locally fabricated");
    const [first, second, third] = projected.resources;
    assert.equal(first!.pathname, "/messages/answer/resources/..%2Fsample.bin");
    assert.match(second!.pathname, /^\/messages\/answer\/resources\/\.\.%2Fsample\.bin\.[a-f0-9]{8}$/u);
    assert.match(third!.pathname, /^\/messages\/answer\/resources\/[a-f0-9]{8}$/u);
    for (const [index, bytes] of [Buffer.from([0, 1, 2]), Buffer.from([255]), Buffer.from([4, 5])].entries()) {
        const channel = projected.resources[index]!.entry.channels.body!;
        assert.equal(channel.mimetype, "application/octet-stream");
        assert.deepEqual(Buffer.from(channel.bytes!), bytes);
        assert.equal(channel.content, "");
    }
    assert.deepEqual(A2aProjection.messageEntry(message, "peer"), projected, "re-reading the same collection preserves resource identities");
});

test("{§a2a-part-resources}: Task status, history and Artifacts retain their own Message/Artifact sources", () => {
    const task = Task.fromJSON({
        id: "task", contextId: "context",
        status: {
            state: "TASK_STATE_INPUT_REQUIRED",
            message: { messageId: "question", role: "ROLE_AGENT", parts: [{ raw: "AA==", mediaType: "image/png" }] },
        },
        history: [{ messageId: "earlier", role: "ROLE_AGENT", parts: [{ raw: "AQ==", mediaType: "audio/wav" }] }],
        artifacts: [{ artifactId: "output", name: "Report", parts: [{ raw: "Ag==", mediaType: "application/pdf" }] }],
    });
    const projected = A2aProjection.taskEntry(task, "peer");
    const entries = new Map(projected.resources.map(({ pathname, entry }) => [pathname, entry]));
    for (const parent of ["/messages/question", "/messages/earlier", "/tasks/task/artifacts/output"]) {
        assert.ok(entries.has(parent));
        assert.match(entries.get(parent)!.channels.body!.content, /<a2a:\/\/peer\/.*\/resources\/[a-f0-9]{8}>/u);
        assert.equal([...entries.keys()].filter((path) => path.startsWith(`${parent}/resources/`)).length, 1);
    }
    assert.equal(entries.size, 6);
    assert.match(projected.entry.channels.body!.content, /state: input-required/u);
    assert.match(projected.entry.channels.body!.content, /\/messages\/question\/resources\//u);
    assert.deepEqual(JSON.parse(projected.entry.channels.json!.content), withResources(Task.toJSON(task), "peer", projected.resources, "task"), "artifacts, history and the status message each name their own resources");
    assert.doesNotMatch(projected.entry.channels.json!.content, /"raw"/u);
});
