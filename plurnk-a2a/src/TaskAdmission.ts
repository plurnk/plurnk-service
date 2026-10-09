import { randomUUID } from "node:crypto";
import { SendMessageRequest, type Message } from "@a2a-js/sdk";
import { ContentTypeNotSupportedError, RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { Problems, type ApplicationPort } from "@plurnk/plurnk-contracts";
import HostedTasks from "./HostedTasks.ts";
import A2aProjection from "./A2aProjection.ts";
import type WorkspaceBinding from "./WorkspaceBinding.ts";

export type AdmissionPort = Pick<ApplicationPort,
    "createConversationWorker" | "readWorker" | "ensureRuntimeWorker" | "runLoop">;

const textOf = (message: Message): string => {
    if (message.parts.length === 0) throw new RequestMalformedError("The A2A Message has no Parts.");
    const text = message.parts.flatMap(({ content }) => {
        if (content === undefined) throw new ContentTypeNotSupportedError("A Message Part has no content.");
        switch (content.$case) {
            case "text": return [content.value];
            case "data": return [JSON.stringify(content.value, null, 2)];
            case "url": return [content.value];
            case "raw": return [];
        }
    }).join("\n");
    if (text.trim().length === 0 && !message.parts.some((part) => part.content?.$case === "raw")) {
        throw new RequestMalformedError("The A2A Message has no non-empty content.");
    }
    return text;
};

// {§a2a-inbound-exposure} Admission creates ordinary Workers and delivers ordinary messages.
export default class TaskAdmission {
    readonly #port: AdmissionPort;
    readonly #workspace: WorkspaceBinding;
    readonly #tasks: HostedTasks;
    readonly #parentWorker: string;

    constructor(port: AdmissionPort, workspace: WorkspaceBinding, tasks: HostedTasks, parentWorker: string) {
        this.#port = port;
        this.#workspace = workspace;
        this.#tasks = tasks;
        this.#parentWorker = parentWorker;
    }

    async admit(request: SendMessageRequest): Promise<string> {
        const incoming = request.message;
        if (!incoming?.messageId) throw new RequestMalformedError("message.messageId is required.");
        const text = textOf(incoming);
        const binding = incoming.taskId ? await this.#tasks.binding(incoming.taskId) : null;
        if (incoming.taskId && binding === null) throw new TaskNotFoundError(`Task not found: ${incoming.taskId}`);
        if (binding !== null && incoming.contextId && incoming.contextId !== binding.contextId) {
            throw new RequestMalformedError(`contextId does not match Task '${incoming.taskId}'.`);
        }
        if (binding !== null && !HostedTasks.open(binding.loop)) {
            throw new UnsupportedOperationError(`Task '${incoming.taskId}' has finished; start a new Task in its Context.`);
        }
        const taskId = binding?.taskId ?? randomUUID();
        const contextId = binding?.contextId ?? (incoming.contextId || randomUUID());
        const message = { ...incoming, taskId, contextId };
        const workspaceId = binding?.workspaceId ?? await this.#workspace.id();
        const modes = request.configuration?.acceptedOutputModes ?? [];
        const body = modes.length === 0 ? text
            : [text, `Accepted output media types: ${JSON.stringify(modes)}`].filter(Boolean).join("\n\n");
        const source = `a2a://anonymous/contexts/${encodeURIComponent(contextId)}`
            + `/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(message.messageId)}`;
        const workerId = binding?.worker.id ?? (await this.#port.createConversationWorker({
            workspaceId, name: taskId, parentWorkerId: await this.#parent(workspaceId),
        })).workerId;
        try {
            await this.#port.runLoop({
                workspaceId,
                workerId,
                ...(binding === null ? {} : { loopId: binding.loop.id }),
                prompt: body,
                envelope: SendMessageRequest.toJSON({ ...request, message }) as Record<string, unknown>,
                attachments: message.parts.flatMap((part) => part.content?.$case === "raw" ? [{
                    name: part.filename,
                    mediaType: part.mediaType || "application/octet-stream",
                    bytes: part.content.value,
                }] : []),
                source,
                messageAddress: source,
                ...(binding === null ? { openPaths: [`a2a://anonymous${A2aProjection.contextPath(contextId)}`] } : {}),
            });
        } catch (cause) {
            if (Problems.fromError(cause)?.type === "https://problems.plurnk.xyz/daemon/admission/loop-not-open") {
                throw new UnsupportedOperationError({ message: `Task '${taskId}' is no longer unfinished.`, cause });
            }
            throw cause;
        }
        return taskId;
    }

    async #parent(workspaceId: number): Promise<number> {
        if (this.#parentWorker === "_plurnk") return this.#port.ensureRuntimeWorker(workspaceId);
        const parent = await this.#port.readWorker({ workspaceId, identity: { name: this.#parentWorker } });
        if (parent === null) throw new RequestMalformedError(`Configured A2A parent Worker '${this.#parentWorker}' does not exist.`);
        return parent.id;
    }
}
