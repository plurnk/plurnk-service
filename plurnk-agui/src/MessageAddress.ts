/** {§agui-run-source}: message identity belongs to the conversation, not its transport run. */
export default class MessageAddress {
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
