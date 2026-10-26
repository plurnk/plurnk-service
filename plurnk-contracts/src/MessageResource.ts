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

import type { LoopLifecycle } from "./LoopLifecycle.ts";

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

/** {§methods-session-inbox} An accepted message its recipient has not yet observed at a turn boundary ({§message-arrival}). */
export interface ApplicationInboxMessage {
    /** The immutable source address Open Messages lists the message by. */
    readonly path: string;
    /** The causal actor's canonical address; null for the operator's own. */
    readonly source: string | null;
    readonly body: string;
    readonly loopId: number;
    /** The lifecycle of the loop holding it ({§loop-lifecycle-vocabulary}): a terminal one will never observe it. */
    readonly lifecycle: LoopLifecycle;
}
