import { Validator, type Notice } from "@plurnk/plurnk-contracts";
import type { NoticeNotify } from "./ChannelWrite.ts";
import type { Db } from "./Db.ts";

// {§operation-results} — the transient notice channel. Progress and diagnostic events broadcast live via
// `notice/event`; packet-eligible loop notices persist in `loop_notices` until a completed emission call
// acknowledges them so restarts across parked loops never drop pending feedback.
export default class NoticeChannel {
    #buffer = new Map<number, Notice[]>();
    #db: Db | undefined;
    #notify: NoticeNotify | undefined;
    #writes: Promise<void> = Promise.resolve();

    constructor({ db, notify }: { db?: Db; notify?: NoticeNotify } = {}) {
        this.#db = db;
        this.#notify = notify;
    }

    push(workspaceId: number, sessionId: number, loopId: number, notice: Notice): void {
        NoticeChannel.#assert(notice);
        const existing = this.#buffer.get(loopId);
        const replacementKey = NoticeChannel.#replacementKey(notice);
        if (existing === undefined) {
            this.#buffer.set(loopId, [notice]);
        } else if (replacementKey !== null) {
            const prior = existing.findIndex((item) => NoticeChannel.#replacementKey(item) === replacementKey);
            if (prior === -1) existing.push(notice);
            else existing[prior] = notice;
        } else {
            existing.push(notice);
        }
        if (this.#db !== undefined && NoticeChannel.#persistsInLoop(notice, replacementKey)) {
            const db = this.#db;
            const serialized = JSON.stringify(notice);
            this.#enqueue(async () => {
                if (replacementKey !== null) {
                    await db.notice_channel_delete_replacement.run({ loop_id: loopId, replacement_key: replacementKey });
                }
                if (notice.level !== "info" || isPacketInfoNotice(notice)) {
                    await db.notice_channel_insert.run({
                        loop_id: loopId,
                        replacement_key: replacementKey,
                        notice: serialized,
                    });
                }
            });
        }
        this.#notify?.(workspaceId, { sessionId, loopId, notice });
    }

    // Live fan-out ONLY, never buffered — for work with no loop to drain the
    // buffer (e.g. workspace-scope derivation warming, loopId 0) or single-packet capacity notices.
    notify(workspaceId: number, sessionId: number | null, loopId: number, notice: Notice): void {
        NoticeChannel.#assert(notice);
        this.#notify?.(workspaceId, { sessionId, loopId, notice });
    }

    // In-memory drain for synchronous callers and standalone unit tests.
    drain(loopId: number): Notice[] {
        const buf = this.#buffer.get(loopId);
        if (buf === undefined) return [];
        this.#buffer.delete(loopId);
        if (this.#db !== undefined) {
            const db = this.#db;
            this.#enqueue(async () => {
                await db.notice_channel_clear.run({ loop_id: loopId });
            });
        }
        return buf;
    }

    async peekDurable(loopId: number): Promise<{ maxId: number; notices: Notice[] }> {
        await this.#writes;
        if (this.#db === undefined) {
            const notices = [...(this.#buffer.get(loopId) ?? [])]
                .filter((event) => event.level !== "info" || isPacketInfoNotice(event));
            return { maxId: notices.length, notices };
        }
        const rows = await this.#db.notice_channel_peek.all<{ id: number; notice: string }>({ loop_id: loopId });
        let maxId = 0;
        const notices: Notice[] = [];
        for (const row of rows) {
            if (row.id > maxId) maxId = row.id;
            const parsed = Validator.assertNotice(JSON.parse(row.notice));
            if (parsed.level !== "info" || isPacketInfoNotice(parsed)) notices.push(parsed);
        }
        return { maxId, notices };
    }

    async acknowledgeDurable(loopId: number, throughId: number): Promise<void> {
        await this.#writes;
        if (this.#db === undefined) {
            if (throughId > 0) this.#buffer.delete(loopId);
            return;
        }
        if (throughId > 0) {
            await this.#db.notice_channel_acknowledge.run({ loop_id: loopId, through_id: throughId });
        }
        const remaining = await this.#db.notice_channel_peek.all<{ notice: string }>({ loop_id: loopId });
        if (remaining.length === 0) {
            this.#buffer.delete(loopId);
        } else {
            this.#buffer.set(loopId, remaining.map((row) => Validator.assertNotice(JSON.parse(row.notice))));
        }
    }

    delete(loopId: number): void {
        this.#buffer.delete(loopId);
        if (this.#db !== undefined) {
            const db = this.#db;
            this.#enqueue(async () => {
                await db.notice_channel_clear.run({ loop_id: loopId });
            });
        }
    }

    flush(): Promise<void> {
        return this.#writes;
    }

    #enqueue(work: () => Promise<void>): void {
        this.#writes = this.#writes.then(work);
    }

    static #persistsInLoop(notice: Notice, replacementKey: string | null): boolean {
        if (loopTelemetryOnly(notice)) return false;
        return replacementKey !== null || notice.level !== "info" || isPacketInfoNotice(notice);
    }

    static #assert(notice: Notice): void {
        Validator.assertNotice(notice);
    }

    static #replacementKey(notice: Notice): string | null {
        if (notice.source === "engine:derivation" && notice.kind === "search_progress") {
            return `${notice.source}:${notice.kind}`;
        }
        if (notice.source === "engine:provider"
            && (notice.kind === "provider_unavailable" || notice.kind === "provider_recovered")) {
            return "engine:provider:availability";
        }
        return null;
    }
}

const isPacketInfoNotice = (notice: Notice): boolean =>
    notice.kind === "results_pending" || notice.kind === "open_messages_unresolved";

const loopTelemetryOnly = (notice: Notice): boolean =>
    (notice.source === "engine:turn" && notice.level === "info" && !isPacketInfoNotice(notice))
    || (notice.source === "engine:loop" && notice.level === "info");
