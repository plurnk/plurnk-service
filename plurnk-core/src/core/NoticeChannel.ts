import { Validator, type Notice } from "@plurnk/plurnk-contracts";
import type { NoticeNotify } from "./ChannelWrite.ts";

// The transient notice channel. Durable operation failures live in log_entries as
// RFC 9457 Problem Details; this buffer carries progress and diagnostic events only.
export default class NoticeChannel {
    #buffer = new Map<number, Notice[]>();
    #notify: NoticeNotify | undefined;

    constructor({ notify }: { notify?: NoticeNotify } = {}) {
        this.#notify = notify;
    }

    push(workspaceId: number, workerId: number, loopId: number, notice: Notice): void {
        NoticeChannel.#assert(notice);
        const existing = this.#buffer.get(loopId);
        if (existing === undefined) {
            this.#buffer.set(loopId, [notice]);
        } else if (NoticeChannel.#isReplaceableProgress(notice)) {
            const prior = existing.findIndex((item) =>
                item.source === notice.source && item.kind === notice.kind
            );
            if (prior === -1) existing.push(notice);
            else existing[prior] = notice;
        } else {
            existing.push(notice);
        }
        this.#notify?.(workspaceId, { workerId, loopId, notice });
    }

    // Live fan-out ONLY, never buffered — for work with no loop to drain the
    // buffer (e.g. workspace-scope derivation warming, loopId 0).
    notify(workspaceId: number, workerId: number | null, loopId: number, notice: Notice): void {
        NoticeChannel.#assert(notice);
        this.#notify?.(workspaceId, { workerId, loopId, notice });
    }

    // Each observation surfaces in one model packet.
    drain(loopId: number): Notice[] {
        const buf = this.#buffer.get(loopId);
        if (buf === undefined) return [];
        this.#buffer.delete(loopId);
        return buf;
    }

    delete(loopId: number): void {
        this.#buffer.delete(loopId);
    }

    static #assert(notice: Notice): void {
        Validator.assertNotice(notice);
    }

    static #isReplaceableProgress(notice: Notice): boolean {
        return notice.source === "engine:derivation" && notice.kind === "embed_progress";
    }
}
