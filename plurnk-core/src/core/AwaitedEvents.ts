import { randomUUID } from "node:crypto";
import { Problems, type OperationResult } from "@plurnk/plurnk-contracts";
import { Results, type AwaitedEventCaps, type AwaitedEventProducer, type AwaitedEventRecord } from "@plurnk/plurnk-schemes";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";

export interface AwaitedEventRow {
    id: number; name: string; workspace_id: number; loop_id: number; scheme: string;
    event: string; source: string; due_at: string | null; result: string | null; observed: number;
}

export type AwaitedEventNotify = (workspaceId: number, workerId: number, loopId: number) => void;

export default class AwaitedEvents {
    readonly #db: Db;
    readonly #notify: AwaitedEventNotify | undefined;

    constructor(db: Db, notify?: AwaitedEventNotify) {
        this.#db = db;
        this.#notify = notify;
    }

    async reconcileProducers(schemes: readonly string[]): Promise<void> {
        await this.#db.awaited_event_producers_missing.run({
            schemes: JSON.stringify(schemes),
            result: JSON.stringify({ status: 503, problem: Problems.create("lifecycle:wait", "producer-unavailable", 503,
                "The awaited event's producer is not registered in this service.") }),
        });
    }

    static record(row: AwaitedEventRow): AwaitedEventRecord {
        return {
            workspaceId: row.workspace_id,
            path: `${row.scheme}:///waits/${row.name}`,
            event: row.event,
            source: row.source,
            ...(row.due_at === null ? {} : { dueAt: row.due_at }),
            result: row.result === null ? null : JSON.parse(row.result) as OperationResult,
        };
    }

    producer(scheme: string): AwaitedEventProducer {
        return {
            pending: async () => (await this.#db.awaited_event_pending.all<AwaitedEventRow>({ scheme })).map(AwaitedEvents.record),
            settle: async (workspaceId, event, result) => {
                AwaitedEvents.#terminal(result);
                const rows = await this.#db.awaited_event_settle.all<{ worker_id: number; loop_id: number }>({
                    workspace_id: workspaceId, scheme, event, result: JSON.stringify(result),
                });
                for (const row of rows) this.#notify?.(workspaceId, row.worker_id, row.loop_id);
            },
        };
    }

    operation(scheme: string, ctx: Pick<PlurnkSchemeContext, "workspaceId" | "workerId" | "loopId">): AwaitedEventCaps {
        const { workspaceId, workerId, loopId } = ctx;
        const read = async (pathname: string): Promise<AwaitedEventRecord | null> => {
            const name = /^\/waits\/([a-f0-9]{8})$/u.exec(pathname)?.[1];
            if (name === undefined) return null;
            const row = await this.#db.awaited_event_get.get<AwaitedEventRow>({ workspace_id: workspaceId, scheme, name });
            return row === undefined ? null : AwaitedEvents.record(row);
        };
        return {
            join: async ({ event, source, dueAt }) => {
                if (event.length === 0 || source.length === 0 || (dueAt !== undefined && !Number.isFinite(Date.parse(dueAt)))) {
                    throw new TypeError("Awaited event requires an identity, source, and valid optional due time.");
                }
                const row = await this.#db.awaited_event_join.get<AwaitedEventRow>({
                    name: randomUUID().slice(0, 8), workspace_id: workspaceId, worker_id: workerId,
                    loop_id: loopId, scheme, event, source, due_at: dueAt ?? null,
                });
                if (row === undefined) return { status: 409, problem: Problems.create("lifecycle:wait", "loop-inactive", 409, "The loop no longer accepts awaited work.") };
                return { status: 200, resource: AwaitedEvents.record(row).path };
            },
            read,
            cancel: async (pathname) => {
                const record = await read(pathname);
                if (record === null) return { status: 404, problem: Problems.create("lifecycle:wait", "not-found", 404, "The awaited event does not exist.") };
                const result = { status: 499, problem: Problems.create("lifecycle:wait", "withdrawn", 499, "This wait was withdrawn; its source is unchanged.") };
                const rows = await this.#db.awaited_event_cancel.all<{ worker_id: number; loop_id: number }>({
                    workspace_id: workspaceId, scheme, name: pathname.slice("/waits/".length), result: JSON.stringify(result),
                });
                for (const row of rows) this.#notify?.(workspaceId, row.worker_id, row.loop_id);
                return { status: 200, resource: record.path };
            },
        };
    }

    static #terminal(result: OperationResult): void {
        Results.assert(result);
        if (result.status < 200 || result.status === 202) throw new TypeError("Awaited event settlement requires a terminal result.");
    }
}
