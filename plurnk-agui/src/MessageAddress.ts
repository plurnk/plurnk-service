import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import type { RunAgentInput, UserMessage } from "./types.ts";

/** {§agui-run-source}: message identity belongs to the conversation, not its transport run. */
export default class MessageAddress {
    static submission(
        { threadId, runId }: Pick<RunAgentInput, "threadId" | "runId">,
        message: UserMessage,
    ): Pick<Parameters<ApplicationPort["runLoop"]>[0], "source" | "messageAddress" | "envelope"> {
        const address = MessageAddress.render(threadId, message.id);
        return { source: address, messageAddress: address, envelope: { threadId, runId, message } };
    }

    static render(threadId: string, messageId: string): string {
        return `agui://anonymous/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`;
    }

    static messageId(address: unknown, threadId: string): string | null {
        const prefix = MessageAddress.render(threadId, "");
        if (typeof address !== "string" || !address.startsWith(prefix)) return null;
        const component = address.slice(prefix.length);
        if (component.length === 0 || component.includes("/")) return null;
        try { return decodeURIComponent(component); } catch { return null; }
    }
}
