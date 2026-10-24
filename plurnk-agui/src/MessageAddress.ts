import type { RunAgentInput, UserMessage } from "./types.ts";

const ADDRESS = /^agui:\/\/[^/]+\/threads\/([^/]*)\/messages\/([^/]+)$/u;

/** {§agui-run-source}: message identity belongs to the thread, not its transport run. */
export default class MessageAddress {
    /** {§agui-worker-owner}: the operator's approval and interaction address in every workspace. */
    static readonly OWNER = "agui://operator";

    static submission(
        { threadId, runId }: Pick<RunAgentInput, "threadId" | "runId">,
        message: UserMessage,
    ): { source: string; messageAddress: string; envelope: Readonly<Record<string, unknown>> } {
        const address = MessageAddress.render(threadId, message.id);
        return { source: address, messageAddress: address, envelope: { threadId, runId, message } };
    }

    static render(threadId: string, messageId: string): string {
        return `${MessageAddress.OWNER}/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`;
    }

    /** The message id of an address on this thread. */
    static messageId(address: unknown, threadId: string): string | null {
        if (typeof address !== "string") return null;
        const match = ADDRESS.exec(address);
        if (match === null || match[1] !== encodeURIComponent(threadId)) return null;
        try { return decodeURIComponent(match[2]); } catch { return null; }
    }
}
