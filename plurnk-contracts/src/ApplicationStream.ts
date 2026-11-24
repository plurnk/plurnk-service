import type { ClientEntryChannel } from "./types.generated.ts";

/** {§methods} A stream the session holds open: what it is, the operation that opened it, and
 *  the state of each of its channels. Identity and coordinates are named as `stream/event` names them. */
export interface ApplicationStream {
    readonly entryId: number;
    /** The initiating Session ({§subscriptions}). */
    readonly sessionId: number;
    /** The canonical resource URI ({§execution-output-identity}). */
    readonly target: string;
    /** ISO-8601 UTC timestamp when the subscription opened ({§subscriptions}). */
    readonly openedAt?: string;
    /** The causal log item, when the stream began in a turn. */
    readonly op?: string;
    readonly aside?: string;
    readonly loopSeq?: number;
    readonly turnSeq?: number;
    readonly sequence?: number;
    /** Every channel of the stream's entry, written or not, by name. */
    readonly channels: readonly ApplicationStreamChannel[];
}

export interface ApplicationStreamChannel {
    readonly channel: string;
    readonly state: ClientEntryChannel["state"];
    readonly mimetype: string;
}
