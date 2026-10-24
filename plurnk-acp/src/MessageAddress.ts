const ADDRESS = /^acp:\/\/[^/]+\/sessions\/([^/]*)\/messages\/([^/]+)$/u;

/** {§acp-daemon-module} Message identity belongs to the ACP session, not a transient request. */
export default class MessageAddress {
    /** {§acp-daemon-module} The operator's approval and interaction address in every workspace. */
    static readonly OWNER = "acp://operator";

    static submission(
        sessionId: string,
        messageId: string,
        prompt: string,
    ): { source: string; messageAddress: string; envelope: Readonly<Record<string, unknown>> } {
        const address = MessageAddress.render(sessionId, messageId);
        return { source: address, messageAddress: address, envelope: { sessionId, messageId, prompt } };
    }

    static render(sessionId: string, messageId: string): string {
        return `${MessageAddress.OWNER}/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`;
    }

    /** The message id of an address on this session. */
    static messageId(address: unknown, sessionId: string): string | null {
        if (typeof address !== "string") return null;
        const match = ADDRESS.exec(address);
        if (match === null || match[1] !== encodeURIComponent(sessionId)) return null;
        try { return decodeURIComponent(match[2]); } catch { return null; }
    }
}
