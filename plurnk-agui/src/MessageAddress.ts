import type { RunAgentInput, UserMessage } from "./types.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

const ADDRESS = /^agui:\/\/[^/]+\/threads\/([^/]*)\/messages\/([^/]+)$/u;

/** {§agui-run-source}: message identity belongs to the thread, not its transport run. */
export default class MessageAddress {
    /** The principal is the credential's subject ({§agui-http-authorization}); `anonymous` names nobody. */
    static owner(principal: string, threadId: string): string {
        return `agui://${encodeURIComponent(principal)}/threads/${encodeURIComponent(threadId)}`;
    }

    static submission(
        principal: string,
        { threadId, runId }: Pick<RunAgentInput, "threadId" | "runId">,
        message: UserMessage,
    ): Pick<Parameters<ApplicationPort["runLoop"]>[0], "source" | "messageAddress" | "envelope"> {
        const address = MessageAddress.render(principal, threadId, message.id);
        return { source: address, messageAddress: address, envelope: { threadId, runId, message } };
    }

    static render(principal: string, threadId: string, messageId: string): string {
        return `${MessageAddress.owner(principal, threadId)}/messages/${encodeURIComponent(messageId)}`;
    }

    /** The message id of an address on this thread, under whichever principal submitted it. */
    static messageId(address: unknown, threadId: string): string | null {
        if (typeof address !== "string") return null;
        const match = ADDRESS.exec(address);
        if (match === null || match[1] !== encodeURIComponent(threadId)) return null;
        try { return decodeURIComponent(match[2]); } catch { return null; }
    }
}
