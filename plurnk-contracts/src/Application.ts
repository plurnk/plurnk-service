import type { LoopLifecycle } from "./LoopLifecycle.ts";
import type { JsonSchema, ModelRoute, OperationResult } from "./types.ts";
import type { RequestHeaders } from "./HttpOrigin.ts";

export type ProposalDecision = "accept" | "reject" | "cancel";

export interface ApplicationOwnerIdentity {
    readonly workspaceId: number;
    readonly address: string;
}

export interface ProposalResolution {
    readonly decision: ProposalDecision;
    readonly body?: string;
    readonly outcome?: string;
}

export type ApplicationActionContext =
    | { readonly scope: "daemon" }
    | { readonly scope: "workspace"; readonly workspaceId: number }
    | { readonly scope: "worker"; readonly workspaceId: number; readonly workerId: number };

export interface ApplicationActionDescriptor {
    readonly name: string;
    readonly scope: ApplicationActionContext["scope"];
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
}

// The bound workspace. Binding one mints nothing: a client operation journals in the workspace's
// runtime worker ({§connection-lifecycle}), and the worker a thread binds is resolved separately by the
// client-interface module.
export interface ClientEnvelope {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    /** {§workspace-label} The folder as the daemon spells it for display; null without a folder. */
    readonly projectLabel: string | null;
}

export type ApplicationWorkerOrigin = "model" | "_plurnk";

// {§application-worker-observation} — `kind` is how the worker was minted (a root worker, a FORK
// child with a forked log, a WORK child with a fresh log); `lifecycle` projects its representative loop
// through the shared {§loop-lifecycle-vocabulary}, so a directory row can carry the same glyph the
// bound worker's own status gauge shows. Neither is inferred by a client.
export type ApplicationWorkerKind = "root" | "fork" | "work";
export interface ApplicationWorkerProjection {
    readonly id: number;
    readonly name: string;
    readonly created_at: string;
    readonly origin: ApplicationWorkerOrigin;
    readonly owner: string;
    readonly parentWorkerId: number | null;
    readonly kind: ApplicationWorkerKind;
    readonly lifecycle: LoopLifecycle;
    /** {§place-hiding} When the worker was hidden, or null while it is shown. */
    readonly hidden_at: string | null;
}

/** {§application-worker-overview} A worker's latest finished reply ({§worker-finished-reply}). */
export interface ApplicationWorkerReply {
    /** The reply's durable log row. */
    readonly id: number;
    /** Its log coordinate `L/T/S` in its worker's log. */
    readonly coordinate: string;
    /** The message completion its receipt records. */
    readonly completion: 200 | 499;
    /** When it was recorded, Unix milliseconds. */
    readonly at: number;
    /** {§list-excerpt} */
    readonly excerpt: string;
    readonly continued: boolean;
}

/** {§application-worker-overview} One place of the overview and what waits there. */
export interface ApplicationOverviewWorker {
    readonly workspaceId: number;
    readonly id: number;
    readonly name: string;
    readonly parentWorkerId: number | null;
    readonly kind: ApplicationWorkerKind;
    readonly lifecycle: LoopLifecycle;
    /** The proposals and client interactions it waits on. */
    readonly gates: number;
    readonly reply: ApplicationWorkerReply | null;
}

/** {§application-worker-overview} A workspace the overview's places belong to. */
export interface ApplicationOverviewWorkspace {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    /** {§workspace-label} */
    readonly projectLabel: string | null;
}

/** {§application-worker-overview} The places in a scope, most recently finished first, and the workspaces they belong to. */
export interface ApplicationWorkerOverview {
    readonly workers: readonly ApplicationOverviewWorker[];
    readonly workspaces: readonly ApplicationOverviewWorkspace[];
    /** The places in scope the overview leaves out. */
    readonly omitted: number;
}

/** {§place-hiding} A workspace's mark after a hide or a show. */
export interface ApplicationWorkspaceHiding {
    readonly id: number;
    /** When the workspace was hidden, or null while it is shown. */
    readonly hidden_at: string | null;
}

/** {§place-hiding} A worker's mark after a hide or a show. */
export interface ApplicationWorkerHiding {
    readonly id: number;
    /** When the worker was hidden, or null while it is shown. */
    readonly hidden_at: string | null;
    /** The workers whose mark the call changed, in id order: the group it hid or showed, none when nothing changed. */
    readonly workerIds: readonly number[];
}

export interface ApplicationWorkerQuery {
    readonly origin?: ApplicationWorkerOrigin;
    /** Omitted means every lineage position; null means roots only. */
    readonly parentWorkerId?: number | null;
    /** {§place-hiding} Omitted lists every worker; true only hidden ones, false only shown ones. */
    readonly hidden?: boolean;
}

export type ApplicationWorkerIdentity =
    | { readonly id: number; readonly name?: never }
    | { readonly id?: never; readonly name: string };

export type ApplicationWorkerCreation = {
    readonly workspaceId: number;
    readonly name?: string;
} & (
    | { readonly parentWorkerId: number; readonly owner?: never }
    | { readonly parentWorkerId?: never; readonly owner?: string }
);

export interface ApplicationLoopProjection {
    readonly id: number;
    readonly workerId: number;
    readonly sequence: number;
    readonly status: number;
    readonly prompt: string;
    readonly promptSource: string | null;
    /** When the loop first ran ({§loop-claim-latency}), ISO 8601 UTC; null until it has. */
    readonly claimedAt: string | null;
    /** When the loop concluded, ISO 8601 UTC; null while it is unfinished. */
    readonly terminatedAt: string | null;
    readonly terminalResult: OperationResult | null;
    /** Exact count of durable packet-bearing turns; retries and administrative turns do not contribute. */
    readonly packetCount: number;
    /** Durable observation deadline, Unix milliseconds; null outside bounded parks. */
    readonly waitUntil: number | null;
    /**
     * {§worker-obligations} The operation that opened the loop, by sending its first message: its worker and its log
     * address in that worker's log. Null when no worker's operation did, or none was recorded.
     */
    readonly invocation: { readonly workerId: number; readonly address: string } | null;
}

export interface ApplicationLoopPacket {
    readonly workerId: number;
    readonly loopId: number;
    /** The loop's number among its worker's loops, the L of its log coordinates. */
    readonly loopSeq: number;
    readonly packetCount: number;
    /** The loop's client gauge once this packet's turn has its call. */
    readonly gauge: ApplicationGauge;
}

/** {§tokenomics-client-gauge} The client gauge: a packet's curation pair and the physical pair of its emission call. */
export interface ApplicationGauge {
    readonly curationWeight: number | null;
    readonly curationBudget: number | null;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
}

// Every log entry carries its logical coordinate — loop_seq/turn_seq/sequence — so the
// client renders ordering without re-deriving it from DB keys. {§methods-log-coordinate}
// A type alias, not an interface: a serialized wire bag must satisfy index-signature
// consumers (Record<string, unknown>), which TypeScript grants aliases but not interfaces.
export type LogEntryWire = {
    id: number;
    worker_id: number;
    // {§methods-log-entry-wire} The worker whose log holds the row, by its immutable name.
    worker_name: string;
    loop_id: number;
    loop_seq: number;
    turn_id: number;
    turn_seq: number;
    sequence: number;
    at: string;
    origin: string;
    source: string | null;
    op: string | null;
    signal: unknown;
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    query: string | null;
    fragment: string | null;
    lineMarker: unknown;
    tx: unknown;
    mimetype_tx: string;
    rx: unknown;
    mimetype_rx: string;
    status_rx: number;
    weight: number;
    attrs: unknown;
    // {§proposal-202-pauses} The row's lifecycle: `proposed` while its operation awaits its decision.
    state: "proposed" | "resolved" | "failed" | "cancelled";
    reasoning?: string;
    // {§methods-readable-reasoning} The request that streamed `reasoning`; absent for history a FORK inherited.
    reasoning_model_call_id?: number;
    reasoning_request_sequence?: number;
    // {§methods-invocation} On a row that discharges an obligation, the log address of the operation that opened it.
    invocation?: string;
    // {§methods-answering} On a reply to a message this worker's operation sent, the log address of that operation.
    answering?: string;
};
/** {§methods-loop-run} A prompt's admission: its acknowledgement, the loop it landed on and how it landed. */
export type ApplicationLoopAdmission = OperationResult & {
    readonly action: "injected_next_turn" | "enqueued_new_loop";
    readonly loopId: number;
    readonly turnSeq?: number;
};

/** {§acp-provider-routes} A declared alias as the route a worker seeded from it gets, its configured effort included. */
export type ApplicationProviderAlias = ModelRoute & {
    readonly alias: string;
    readonly active: boolean;
    readonly inputCapacity: number | null;
};

export type ApplicationEventHandler = (
    workspaceId: number | null,
    method: string,
    params: unknown,
) => void;

/**
 * {§credential-authority} The kind of a credential: an access token is presented as a bearer; a
 * refresh token is exchanged for new credentials of its family and is never presented; a session
 * is a browser's standing at the authorization server ({§auth-oauth-session}), never a bearer.
 */
export type CredentialKind = "access" | "refresh" | "session";

/**
 * {§credential-authority} What an issued credential stands for. `family` names the grant it descends
 * from: revocation is by family, so an access token and the refresh token that renews it fall together.
 */
export interface CredentialClaims {
    readonly kind: CredentialKind;
    readonly subject: string;
    readonly clientId: string;
    readonly scopes: readonly string[];
    readonly family: string;
    readonly expiresAt: number;
}

export interface IssuedCredential {
    readonly token: string;
    readonly expiresAt: number;
}

/**
 * {§credential-authority} The issuing face of the authority, published by the module that issues:
 * the issuer origin where a request's caller obtains credentials, or, asked with no request in hand,
 * the configured issuer or the listener's own origin; answered from the moment it is published
 * ({§http-request-origin}). Published, the daemon authenticates; absent, every mounted resource
 * admits anonymously.
 */
export interface CredentialFace {
    readonly issuer: (req?: RequestHeaders) => string;
}

/**
 * {§credential-sessions} A live browser sign-in: the family every credential of that sign-in shares,
 * which is its handle and never a credential; whose it is; when it was established; when the last
 * of its session credentials expires; and the clients holding credentials in it. Never a token.
 */
export interface CredentialSession {
    readonly family: string;
    readonly subject: string;
    readonly createdAt: number;
    readonly expiresAt: number;
    readonly clients: readonly string[];
}

/**
 * {§credential-module-client} The confidential client a module of this daemon registers for itself at
 * setup: its id, the absolute pathnames under its own mounts it may be answered at, the scopes it may
 * ask for and, optionally, the pathname of a stylesheet it serves for the authority's documents shown
 * to its requests ({§auth-oauth-documents}). The issuer supplies the origin of each. What others may
 * know of it; never its secret.
 */
export interface ModuleClient {
    readonly id: string;
    readonly redirectPaths: readonly string[];
    readonly scopes: readonly string[];
    readonly stylesheetPath?: string;
}

/**
 * {§credential-authority} The daemon's one authority over the credentials presented to its listener:
 * opaque tokens it issued, live until they expire, are consumed or their family is revoked. Every
 * exterior adapter verifies through it; the client protocol is its issuing face.
 */
export interface CredentialAuthority {
    /**
     * The operator's client secret, `PLURNK_SECRET` when set, else one minted for this boot; null
     * when the daemon authenticates nothing (`PLURNK_AUTH=0`) and no credential exists.
     */
    readonly operatorSecret: string | null;
    issue(credential: Omit<CredentialClaims, "expiresAt"> & { readonly ttlMs: number }): IssuedCredential;
    /** The claims of a live credential; null for one unknown, expired, consumed or revoked. */
    verify(token: string): CredentialClaims | null;
    /**
     * Retires a live refresh token in exchange for new credentials of its family. A token already
     * retired is a reuse: its whole family is revoked and named; anything else answers null.
     */
    consume(token: string): { readonly claims: CredentialClaims } | { readonly reusedFamily: string | null };
    revokeFamily(family: string): void;
    onRevoked(listener: (family: string) => void): () => void;
    /** {§credential-sessions} The live browser sign-ins of `subject`, oldest first; never a token. */
    sessions(subject: string): readonly CredentialSession[];
    /**
     * Registers the calling module's own confidential client and answers its secret, minted for
     * this boot, held in memory and told to nobody else. A second registration of one id is a fault.
     */
    registerClient(client: ModuleClient): { readonly clientId: string; readonly clientSecret: string };
    /** A module's registered client, without its secret; null for an id no module registered. */
    client(id: string): ModuleClient | null;
    /** Whether `secret` is the one minted for the module client `id`, compared in constant time. */
    authenticateClient(id: string, secret: string): boolean;
    /** Publishes the one issuing face; a second publication is a configuration fault. */
    publish(face: CredentialFace): void;
    /** The published face, or null while nothing issues: the daemon authenticates nothing. */
    face(): CredentialFace | null;
}
