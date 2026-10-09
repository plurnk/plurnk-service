import { Role, taskStateToJSON } from "@a2a-js/sdk";
import A2aProjection, { type A2aEntryProjection, type A2aResource } from "./A2aProjection.ts";
import HostedTasks, { type HostedTasksPort } from "./HostedTasks.ts";

// {§a2a-context-resource} A projection over retained messages, without its own persistence.
export default class HostedResources {
    readonly #port: HostedTasksPort;

    constructor(port: HostedTasksPort) {
        this.#port = port;
    }

    async read(workspaceId: number, pathname: string): Promise<A2aEntryProjection | null> {
        const match = /^\/contexts\/([^/]+)(?:\/|$)/u.exec(pathname);
        if (match === null) return null;
        let contextId: string;
        try { contextId = decodeURIComponent(match[1]!); } catch { return null; }
        const prefix = A2aProjection.contextPath(contextId);
        const bindings = (await HostedTasks.bindings(this.#port, workspaceId))
            .filter((binding) => binding.contextId === contextId).toReversed();
        if (bindings.length === 0) return null;
        const resources: A2aResource[] = [];
        const body = [`# Context ${JSON.stringify(contextId)}`];
        const tasks: unknown[] = [];
        for (const binding of bindings) {
            const task = await HostedTasks.conversation(this.#port, binding);
            const projected = A2aProjection.taskEntry(task, "anonymous", prefix);
            resources.push(...projected.resources, { pathname: A2aProjection.taskPath(task.id, prefix), entry: projected.entry });
            tasks.push(JSON.parse(projected.entry.channels.json!.content));
            const state = taskStateToJSON(task.status?.state ?? 0).replace(/^TASK_STATE_/u, "").toLowerCase();
            body.push(`## Task ${task.id} — ${state}`);
            for (const message of task.history) {
                const content = A2aProjection.parts(message.parts, "anonymous", A2aProjection.messagePath(message.messageId, prefix));
                const source = `a2a://anonymous${A2aProjection.taskPath(task.id, prefix)}/messages/${encodeURIComponent(message.messageId)}`;
                body.push(message.role === Role.ROLE_USER ? `### Caller — <${source}>` : "### Agent");
                const answers = message.metadata?.answers;
                if (message.role === Role.ROLE_AGENT && Array.isArray(answers)) {
                    body.push(`Answers: ${answers.map((address) => `<${String(address)}>`).join(", ")}`);
                }
                body.push(content.body);
            }
            if (task.artifacts.length > 0) {
                body.push(...task.artifacts.map((artifact) =>
                    `Artifact: a2a://anonymous${A2aProjection.artifactPath(task.id, artifact.artifactId, prefix)}`));
            }
        }
        if (pathname !== prefix) {
            const resource = resources.find((item) => item.pathname === pathname);
            return resource === undefined ? null : { entry: resource.entry, resources: [] };
        }
        return {
            entry: {
                channels: {
                    body: { content: `${body.join("\n")}\n`, mimetype: "text/markdown" },
                    json: { content: `${JSON.stringify({ contextId, tasks }, null, 2)}\n`, mimetype: "application/json" },
                },
                attributes: { kind: "context", contextId },
            },
            resources,
        };
    }
}
