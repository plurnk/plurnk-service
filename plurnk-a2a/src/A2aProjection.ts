import {
    AgentCard,
    Artifact,
    Message,
    Task,
    taskStateToJSON,
    type Part,
} from "@a2a-js/sdk";
import type { EntryData } from "@plurnk/plurnk-schemes";

export interface A2aTaskContent {
    readonly body: string;
    readonly json: string;
}

const serialized = <T>(codec: { toJSON(value: T): unknown }, value: T): string =>
    `${JSON.stringify(codec.toJSON(value), null, 2)}\n`;

/** Model-oriented projections of canonical A2A v1 resources. */
export default class A2aProjection {
    static taskPath(taskId: string): string {
        return `/tasks/${encodeURIComponent(taskId)}`;
    }

    static messagePath(messageId: string): string {
        return `/messages/${encodeURIComponent(messageId)}`;
    }

    static artifactPath(taskId: string, artifactId: string): string {
        return `${A2aProjection.taskPath(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
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

    static taskEntry(task: Task, authority: string): EntryData {
        const content = A2aProjection.taskContent(task, authority);
        return {
            channels: {
                body: { content: content.body, mimetype: "text/markdown" },
                json: { content: content.json, mimetype: "application/json" },
            },
            attributes: {
                kind: "task",
                taskId: task.id,
                contextId: task.contextId,
            },
        };
    }

    static taskContent(task: Task, authority: string): A2aTaskContent {
        const state = taskStateToJSON(task.status?.state ?? 0)
            .replace(/^TASK_STATE_/, "")
            .toLowerCase()
            .replaceAll("_", "-");
        const statusMessage = task.status?.message === undefined
            ? []
            : ["message:", A2aProjection.#parts(task.status.message.parts)];
        const artifacts = task.artifacts.length === 0
            ? "none"
            : task.artifacts.map((artifact) => {
                const label = artifact.name.length > 0 ? artifact.name : artifact.artifactId;
                return `- ${label}: a2a://${authority}${A2aProjection.artifactPath(task.id, artifact.artifactId)}`;
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
            json: serialized(Task, task),
        };
    }

    static messageEntry(message: Message): EntryData {
        return {
            channels: {
                body: {
                    content: [
                        `messageId: ${message.messageId}`,
                        `contextId: ${message.contextId}`,
                        "",
                        A2aProjection.#parts(message.parts),
                    ].join("\n"),
                    mimetype: "text/markdown",
                },
                json: { content: serialized(Message, message), mimetype: "application/json" },
            },
            attributes: {
                kind: "message",
                messageId: message.messageId,
                contextId: message.contextId,
            },
        };
    }

    static artifactEntry(task: Task, artifact: Artifact): EntryData {
        return {
            channels: {
                body: {
                    content: [
                        `artifactId: ${artifact.artifactId}`,
                        `taskId: ${task.id}`,
                        `contextId: ${task.contextId}`,
                        ...(artifact.name.length === 0 ? [] : [`name: ${artifact.name}`]),
                        ...(artifact.description.length === 0 ? [] : [`description: ${artifact.description}`]),
                        "",
                        A2aProjection.#parts(artifact.parts),
                    ].join("\n"),
                    mimetype: "text/markdown",
                },
                json: { content: serialized(Artifact, artifact), mimetype: "application/json" },
            },
            attributes: {
                kind: "artifact",
                taskId: task.id,
                contextId: task.contextId,
                artifactId: artifact.artifactId,
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

    static #parts(parts: readonly Part[]): string {
        if (parts.length === 0) return "(no content)";
        return parts.map((part, index) => {
            const heading = parts.length === 1 ? "" : `### Part ${index + 1}\n\n`;
            const content = part.content;
            if (content === undefined) return `${heading}(empty part)`;
            if (content.$case === "text") return `${heading}${content.value}`;
            if (content.$case === "url") return `${heading}${content.value}`;
            if (content.$case === "data") {
                return `${heading}\`\`\`json\n${JSON.stringify(content.value, null, 2)}\n\`\`\``;
            }
            return `${heading}[${part.mediaType || "application/octet-stream"}; ${content.value.length} bytes; exact base64 in #json]`;
        }).join("\n\n");
    }
}
