/** Transport-neutral bytes selected for explicit message delivery. */
export interface MessageResource {
    readonly name: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
    readonly target?: string;
}

/** Durable receipt descriptor; payloads remain in the immutable content store. */
export interface MessageResourceReceipt {
    readonly name: string;
    readonly mediaType: string;
    readonly contentHash: string;
    readonly target?: string;
}

export interface MessageEvidence {
    readonly envelope?: Readonly<Record<string, unknown>>;
    readonly attachments?: readonly MessageResourceReceipt[];
}

export interface ApplicationMessage {
    readonly id: number;
    readonly loopId: number;
    readonly direction: "inbound" | "outbound";
    readonly source: string | null;
    /** Message addresses answered by an outbound reply; empty for incoming messages. */
    readonly answers: readonly string[];
    readonly body: string;
    readonly envelope?: Readonly<Record<string, unknown>>;
    readonly attachments: readonly MessageResource[];
}
