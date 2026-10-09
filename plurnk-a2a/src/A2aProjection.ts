import {
    AgentCard,
    Artifact,
    Message,
    Task,
    taskStateToJSON,
    type Part,
} from "@a2a-js/sdk";
import { ResourceNames, type EntryData } from "@plurnk/plurnk-schemes";

export interface A2aResource {
    readonly pathname: string;
    readonly entry: EntryData;
}

export interface A2aEntryProjection {
    readonly entry: EntryData;
    readonly resources: readonly A2aResource[];
}

export interface A2aTaskContent {
    readonly body: string;
    readonly json: string;
    readonly resources: readonly A2aResource[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// {§a2a-part-resources} — the protocol JSON stays readable, but a raw Part's bytes never ride it: the
// Part names its resource and its byte count, the same address the body channel links to.
const partsWithResources = (parts: unknown, authority: string, parent: string): unknown => {
    if (!Array.isArray(parts)) return parts;
    const names = new ResourceNames();
    return parts.map((part, index) => {
        if (!isRecord(part) || typeof part.raw !== "string") return part;
        const { raw, ...rest } = part;
        const filename = typeof part.filename === "string" ? part.filename : "";
        const pathname = `${parent}/resources/${names.allocate(filename, `${parent}/${index}`)}`;
        return { ...rest, resource: `a2a://${authority}${pathname}`, bytes: Buffer.from(raw, "base64").length };
    });
};

const messageJson = (message: unknown, authority: string, prefix: string): unknown => {
    if (!isRecord(message) || typeof message.messageId !== "string") return message;
    return { ...message, parts: partsWithResources(message.parts, authority, A2aProjection.messagePath(message.messageId, prefix)) };
};

const artifactJson = (artifact: unknown, authority: string, taskId: string, prefix: string): unknown => {
    if (!isRecord(artifact) || typeof artifact.artifactId !== "string") return artifact;
    return { ...artifact, parts: partsWithResources(artifact.parts, authority, A2aProjection.artifactPath(taskId, artifact.artifactId, prefix)) };
};

const taskJson = (task: unknown, authority: string, prefix: string): unknown => {
    if (!isRecord(task) || typeof task.id !== "string") return task;
    const status = isRecord(task.status) ? { ...task.status, ...("message" in task.status ? { message: messageJson(task.status.message, authority, prefix) } : {}) } : task.status;
    return {
        ...task,
        ...(Array.isArray(task.artifacts) ? { artifacts: task.artifacts.map((artifact) => artifactJson(artifact, authority, task.id as string, prefix)) } : {}),
        ...(Array.isArray(task.history) ? { history: task.history.map((message) => messageJson(message, authority, prefix)) } : {}),
        ...(status === undefined ? {} : { status }),
    };
};

const serialized = <T>(codec: { toJSON(value: T): unknown }, value: T, project: (json: unknown) => unknown = (json) => json): string =>
    `${JSON.stringify(project(codec.toJSON(value)), null, 2)}\n`;

/** Model-oriented projections of canonical A2A v1 resources. */
export default class A2aProjection {
    static contextPath(contextId: string): string {
        return `/contexts/${encodeURIComponent(contextId)}`;
    }

    static taskPath(taskId: string, prefix = ""): string {
        return `${prefix}/tasks/${encodeURIComponent(taskId)}`;
    }

    static messagePath(messageId: string, prefix = ""): string {
        return `${prefix}/messages/${encodeURIComponent(messageId)}`;
    }

    static artifactPath(taskId: string, artifactId: string, prefix = ""): string {
        return `${A2aProjection.taskPath(taskId, prefix)}/artifacts/${encodeURIComponent(artifactId)}`;
    }

    static taskIdentity(pathname: string): string | null {
        const match = /^\/tasks\/([^/]+)$/.exec(pathname);
        if (match === null) return null;
        try {
            const taskId = decodeURIComponent(match[1]!);
            return A2aProjection.taskPath(taskId) === pathname ? taskId : null;
        } catch {
            return null;
        }
    }

    static artifactIdentity(pathname: string): { taskId: string; artifactId: string } | null {
        const match = /^\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(pathname);
        if (match === null) return null;
        try {
            const taskId = decodeURIComponent(match[1]!);
            const artifactId = decodeURIComponent(match[2]!);
            return A2aProjection.artifactPath(taskId, artifactId) === pathname
                ? { taskId, artifactId }
                : null;
        } catch {
            return null;
        }
    }

    static taskSeed(task: Task): EntryData {
        return {
            channels: {
                body: { content: "", mimetype: "text/markdown", state: "active" },
                json: { content: "", mimetype: "application/json", state: "active" },
            },
            attributes: {
                kind: "task",
                taskId: task.id,
                contextId: task.contextId,
            },
        };
    }

    static taskEntry(task: Task, authority: string, prefix = ""): A2aEntryProjection {
        const content = A2aProjection.taskContent(task, authority, prefix);
        return {
            resources: content.resources,
            entry: {
                channels: {
                    body: { content: content.body, mimetype: "text/markdown" },
                    json: { content: content.json, mimetype: "application/json" },
                },
                attributes: {
                    kind: "task",
                    taskId: task.id,
                    contextId: task.contextId,
                },
            },
        };
    }

    static taskContent(task: Task, authority: string, prefix = ""): A2aTaskContent {
        const state = taskStateToJSON(task.status?.state ?? 0)
            .replace(/^TASK_STATE_/, "")
            .toLowerCase()
            .replaceAll("_", "-");
        const resources: A2aResource[] = [];
        const messages = new Map(task.history.map((message) => [message.messageId, message]));
        const currentMessage = task.status?.message;
        if (currentMessage !== undefined) messages.set(currentMessage.messageId, currentMessage);
        let statusMessage: string[] = [];
        for (const message of messages.values()) {
            const projected = A2aProjection.messageEntry(message, authority, prefix);
            resources.push(...projected.resources, {
                pathname: A2aProjection.messagePath(message.messageId, prefix),
                entry: projected.entry,
            });
            if (message === currentMessage) statusMessage = ["message:", projected.entry.channels.body!.content];
        }
        for (const artifact of task.artifacts) {
            const projected = A2aProjection.artifactEntry(task, artifact, authority, prefix);
            resources.push(...projected.resources, {
                pathname: A2aProjection.artifactPath(task.id, artifact.artifactId, prefix),
                entry: projected.entry,
            });
        }
        const artifacts = task.artifacts.length === 0
            ? "none"
            : task.artifacts.map((artifact) => {
                const label = artifact.name.length > 0 ? artifact.name : artifact.artifactId;
                return `- ${label}: a2a://${authority}${A2aProjection.artifactPath(task.id, artifact.artifactId, prefix)}`;
            }).join("\n");
        return {
            body: [
                `state: ${state}`,
                `taskId: ${task.id}`,
                `contextId: ${task.contextId}`,
                ...statusMessage,
                "artifacts:",
                artifacts,
                "",
            ].join("\n"),
            json: serialized(Task, task, (json) => taskJson(json, authority, prefix)),
            resources,
        };
    }

    static messageEntry(message: Message, authority: string, prefix = ""): A2aEntryProjection {
        const parts = A2aProjection.parts(message.parts, authority, A2aProjection.messagePath(message.messageId, prefix));
        return {
            resources: parts.resources,
            entry: {
                channels: {
                    body: {
                        content: [
                            `messageId: ${message.messageId}`,
                            `contextId: ${message.contextId}`,
                            "",
                            parts.body,
                        ].join("\n"),
                        mimetype: "text/markdown",
                    },
                    json: { content: serialized(Message, message, (json) => messageJson(json, authority, prefix)), mimetype: "application/json" },
                },
                attributes: {
                    kind: "message",
                    messageId: message.messageId,
                    contextId: message.contextId,
                },
            },
        };
    }

    static artifactEntry(task: Task, artifact: Artifact, authority: string, prefix = ""): A2aEntryProjection {
        const parts = A2aProjection.parts(artifact.parts, authority, A2aProjection.artifactPath(task.id, artifact.artifactId, prefix));
        return {
            resources: parts.resources,
            entry: {
                channels: {
                    body: {
                        content: [
                            `artifactId: ${artifact.artifactId}`,
                            `taskId: ${task.id}`,
                            `contextId: ${task.contextId}`,
                            ...(artifact.name.length === 0 ? [] : [`name: ${artifact.name}`]),
                            ...(artifact.description.length === 0 ? [] : [`description: ${artifact.description}`]),
                            "",
                            parts.body,
                        ].join("\n"),
                        mimetype: "text/markdown",
                    },
                    json: { content: serialized(Artifact, artifact, (json) => artifactJson(json, authority, task.id, prefix)), mimetype: "application/json" },
                },
                attributes: {
                    kind: "artifact",
                    taskId: task.id,
                    contextId: task.contextId,
                    artifactId: artifact.artifactId,
                },
            },
        };
    }

    static agentCardEntry(card: AgentCard): EntryData {
        const skills = card.skills.length === 0
            ? "none"
            : card.skills.map((skill) => `- ${skill.id}: ${skill.description}`).join("\n");
        return {
            channels: {
                body: {
                    content: [
                        `# ${card.name}`,
                        "",
                        card.description,
                        "",
                        "skills:",
                        skills,
                        "",
                    ].join("\n"),
                    mimetype: "text/markdown",
                },
                json: { content: serialized(AgentCard, card), mimetype: "application/json" },
            },
            attributes: { kind: "agent-card" },
        };
    }

    static parts(parts: readonly Part[], authority: string, parent: string): {
        body: string;
        resources: A2aResource[];
    } {
        const names = new ResourceNames();
        const resources: A2aResource[] = [];
        const body = parts.map((part, index) => {
            const heading = parts.length === 1 ? "" : `### Part ${index + 1}\n\n`;
            const content = part.content;
            if (content === undefined) return `${heading}(empty part)`;
            if (content.$case === "text") return `${heading}${content.value}`;
            if (content.$case === "url") return `${heading}${content.value}`;
            if (content.$case === "data") {
                return `${heading}\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``;
            }
            const pathname = `${parent}/resources/${names.allocate(part.filename, `${parent}/${index}`)}`;
            const mimetype = part.mediaType || "application/octet-stream";
            resources.push({
                pathname,
                entry: {
                    channels: { body: { content: "", bytes: content.value, mimetype } },
                    attributes: { kind: "part" },
                },
            });
            return `${heading}<a2a://${authority}${pathname}> (${mimetype}; ${content.value.length} bytes)`;
        }).join("\n\n");
        return { body: body || "(no content)", resources };
    }
}
