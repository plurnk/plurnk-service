import { TaskState, type Task } from "@a2a-js/sdk";
import type { ServerCallContext } from "@a2a-js/sdk/server";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type HostedTasks from "./HostedTasks.ts";

export type ObservationPort = Pick<ApplicationPort, "subscribeToEvents">;

type Wake = { changed: ReturnType<typeof Promise.withResolvers<void>>; stopped: boolean };

// {§a2a-task-observation} Request-local wake signals, never a second Task event bus or state store.
export default class TaskObservation {
    readonly #port: ObservationPort;
    readonly #tasks: Pick<HostedTasks, "binding" | "load">;
    readonly #active = new Map<AsyncGenerator<Task>, Wake>();
    #closed = false;

    constructor(port: ObservationPort, tasks: Pick<HostedTasks, "binding" | "load">) {
        this.#port = port;
        this.#tasks = tasks;
    }

    static terminal(task: Task): boolean {
        switch (task.status?.state) {
            case TaskState.TASK_STATE_SUBMITTED:
            case TaskState.TASK_STATE_WORKING: return false;
            case TaskState.TASK_STATE_COMPLETED:
            case TaskState.TASK_STATE_FAILED:
            case TaskState.TASK_STATE_CANCELED: return true;
            default: throw new Error(`Hosted Task '${task.id}' has no Plurnk lifecycle projection.`);
        }
    }

    follow(start: () => Promise<string>, context: ServerCallContext): AsyncGenerator<Task> {
        if (this.#closed) throw new Error("A2A observation is closed.");
        const wake: Wake = { changed: Promise.withResolvers<void>(), stopped: false };
        const stream = this.#snapshots(start, context, wake, () => { this.#active.delete(stream); });
        this.#active.set(stream, wake);
        return stream;
    }

    async close(): Promise<void> {
        this.#closed = true;
        const active = [...this.#active];
        for (const [, wake] of active) {
            wake.stopped = true;
            wake.changed.resolve();
        }
        const results = await Promise.allSettled(active.map(([stream]) => stream.return(undefined)));
        this.#active.clear();
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(({ reason }) => reason);
        if (errors.length > 0) throw new AggregateError(errors, "A2A observation cleanup failed.");
    }

    async *#snapshots(start: () => Promise<string>, context: ServerCallContext, wake: Wake, release: () => void): AsyncGenerator<Task> {
        let recipient: { workspaceId: number; workerId: number } | null = null;
        const unsubscribe = this.#port.subscribeToEvents((workspaceId, method, params) => {
            if (method !== "loop/terminated" && method !== "notice/event") return;
            if (typeof params !== "object" || params === null) return;
            const event = params as { workerId?: number; notice?: { kind?: string } };
            if (method === "notice/event" && event.notice?.kind !== "loop_status") return;
            if (recipient !== null && (workspaceId !== recipient.workspaceId || event.workerId !== recipient.workerId)) return;
            wake.changed.resolve();
        });
        try {
            if (wake.stopped) return;
            const taskId = await start();
            if (wake.stopped) return;
            const binding = await this.#tasks.binding(taskId);
            if (binding === null) throw new TaskNotFoundError(`Task not found: ${taskId}`);
            recipient = { workspaceId: binding.workspaceId, workerId: binding.worker.id };
            while (!wake.stopped) {
                // Reset before reading: a change during the read or yield schedules another read.
                wake.changed = Promise.withResolvers<void>();
                const task = await this.#tasks.load(taskId, context);
                if (wake.stopped) return;
                if (task === undefined) throw new Error(`A2A Task '${taskId}' disappeared during observation.`);
                yield task;
                if (TaskObservation.terminal(task)) return;
                await wake.changed.promise;
            }
        } finally {
            unsubscribe();
            release();
        }
    }
}
