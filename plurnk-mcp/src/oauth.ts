import { randomUUID } from "node:crypto";
import type {
    OAuthClientInformationContext,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    StoredOAuthClientInformation,
    StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import packageJson from "../package.json" with { type: "json" };

// {§oauth-continuation} Host-owned diagnostics, without remote error bodies or secrets.
export class OAuthSetupError extends Error {
    readonly code: string;
    readonly recovery: string | undefined;
    constructor(code: string, message: string, recovery?: string) {
        super(message);
        this.name = "OAuthSetupError";
        this.code = code;
        this.recovery = recovery;
    }
}

// {§oauth-grant} What a sign-in leaves for its alias's later connections: the client registered and the tokens issued,
// per authorization server, with the redirect the registration names. Each connection's provider reads and writes the one
// grant, so a refreshed or rotated token serves every connection after it.
// {§oauth-grant} What `list` shows of a grant; never a token.
export interface OAuthGrantSummary {
    readonly issuer: string;
    // As the authorization server stated it.
    readonly scope?: string;
    readonly refreshable: boolean;
}

export class OAuthGrant {
    readonly redirectUrl: string;
    readonly clientInformation = new Map<string, StoredOAuthClientInformation>();
    readonly tokens = new Map<string, StoredOAuthTokens>();
    configuredIssuer: string | undefined;
    activeIssuer: string | undefined;
    currentTokens: StoredOAuthTokens | undefined;
    // Latched by the first tokens issued; the redirect of an accepted grant has no client waiting at it.
    accepted = false;

    constructor(redirectUrl: string) {
        this.redirectUrl = redirectUrl;
    }

    get signedIn(): boolean {
        return this.currentTokens !== undefined;
    }

    get summary(): OAuthGrantSummary | undefined {
        const tokens = this.currentTokens;
        if (tokens?.issuer === undefined) return undefined;
        return {
            issuer: tokens.issuer,
            ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
            refreshable: tokens.refresh_token !== undefined,
        };
    }
}

export default class InteractiveOAuthProvider implements OAuthClientProvider {
    readonly redirectUrl: string;
    readonly clientMetadataUrl: string | undefined;
    readonly grant: OAuthGrant;
    readonly #redirectConfigured: boolean;
    readonly #scope: string | undefined;
    readonly #issuer: string | undefined;
    readonly #authorizationParams: Readonly<Record<string, string>>;
    readonly #configuredClientInformation: StoredOAuthClientInformation | undefined;
    #presentedToken = false;
    #awaitingAuthorizationCallback = false;
    #state: string | undefined;
    #authorization: { readonly url?: URL } | undefined;
    #codeVerifier: string | undefined;
    #discoveryState: OAuthDiscoveryState | undefined;

    constructor({
        grant,
        redirectConfigured,
        clientMetadataUrl,
        clientId,
        clientSecret,
        scope,
        issuer,
        authorizationParams = {},
    }: {
        grant: OAuthGrant;
        // Whether the definition configures the grant's redirect, where a client always waits.
        redirectConfigured: boolean;
        clientMetadataUrl?: string;
        clientId?: string;
        clientSecret?: string;
        scope?: string;
        issuer?: string;
        authorizationParams?: Readonly<Record<string, string>>;
    }) {
        this.grant = grant;
        this.redirectUrl = grant.redirectUrl;
        this.#redirectConfigured = redirectConfigured;
        this.clientMetadataUrl = clientMetadataUrl;
        this.#scope = scope;
        this.#issuer = issuer;
        this.#authorizationParams = authorizationParams;
        this.#configuredClientInformation = clientId === undefined
            ? undefined
            : { client_id: clientId, ...(clientSecret === undefined ? {} : { client_secret: clientSecret }) };
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: packageJson.name,
            redirect_uris: [this.redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...(this.#scope === undefined ? {} : { scope: this.#scope }),
        };
    }

    state(): string {
        this.#state = randomUUID();
        return this.#state;
    }

    clientInformation(
        context?: OAuthClientInformationContext,
    ): StoredOAuthClientInformation | undefined {
        const grant = this.grant;
        const issuer = context?.issuer ?? grant.activeIssuer;
        if (issuer === undefined) return undefined;
        grant.activeIssuer = issuer;
        const stored = grant.clientInformation.get(issuer);
        if (stored !== undefined) return stored;
        if (
            this.#configuredClientInformation === undefined
            || (grant.configuredIssuer !== undefined && grant.configuredIssuer !== issuer)
        ) {
            const metadata = this.#discoveryState?.authorizationServerMetadata;
            const cimdAvailable = this.clientMetadataUrl !== undefined
                && metadata?.client_id_metadata_document_supported === true;
            if (!cimdAvailable && metadata?.registration_endpoint === undefined) {
                throw new OAuthSetupError("oauth-registration-unavailable",
                    "No client is registered with the authorization server: none is configured for it, it "
                    + "advertises no Dynamic Client Registration endpoint, and no client metadata document it "
                    + "accepts is configured.",
                );
            }
            return undefined;
        }
        grant.configuredIssuer = issuer;
        const configured = { ...this.#configuredClientInformation, issuer };
        grant.clientInformation.set(issuer, configured);
        return configured;
    }

    saveClientInformation(
        clientInformation: StoredOAuthClientInformation,
        context?: OAuthClientInformationContext,
    ): void {
        const issuer = context?.issuer ?? clientInformation.issuer;
        if (issuer === undefined) {
            throw new Error("MCP OAuth client information is missing its authorization-server issuer.");
        }
        this.grant.activeIssuer = issuer;
        this.grant.clientInformation.set(issuer, { ...clientInformation, issuer });
    }

    tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
        if (context === undefined) {
            this.#presentedToken = this.grant.currentTokens !== undefined;
            return this.grant.currentTokens;
        }
        this.grant.activeIssuer = context.issuer;
        return this.grant.tokens.get(context.issuer);
    }

    saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): void {
        const issuer = context?.issuer ?? tokens.issuer;
        if (issuer === undefined) {
            throw new Error("MCP OAuth tokens are missing their authorization-server issuer.");
        }
        const stored = { ...tokens, issuer };
        const grant = this.grant;
        grant.activeIssuer = issuer;
        grant.currentTokens = stored;
        grant.accepted = true;
        this.#presentedToken = false;
        this.#awaitingAuthorizationCallback = false;
        grant.tokens.set(issuer, stored);
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        // {§oauth-grant} A sign-in starts only where a client waits at the redirect: one the definition configures, or the
        // callback a client bound to begin this grant. Elsewhere the grant no longer answers, and the alias awaits a sign-in.
        if (!this.#redirectConfigured && this.grant.accepted) {
            this.#authorization = {};
            return;
        }
        // {§mcp-server-definition} The definition's parameters join the request; the schema keeps the flow's own out of reach.
        for (const [name, value] of Object.entries(this.#authorizationParams)) authorizationUrl.searchParams.set(name, value);
        this.#awaitingAuthorizationCallback = true;
        this.#authorization = { url: authorizationUrl };
    }

    // The sign-in the SDK last asked for, with its URL where this connection starts one.
    takeAuthorization(): { readonly url?: URL } | undefined {
        const authorization = this.#authorization;
        this.#authorization = undefined;
        return authorization;
    }

    assertCallbackState(callback: URL): void {
        if (this.#state === undefined || callback.searchParams.get("state") !== this.#state) {
            throw new Error("OAuth callback state does not match the pending authorization request.");
        }
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.#codeVerifier = codeVerifier;
    }

    codeVerifier(): string {
        if (this.#codeVerifier === undefined) {
            throw new Error("OAuth authorization has no pending PKCE verifier.");
        }
        return this.#codeVerifier;
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        if (state.authorizationServerMetadata === undefined) {
            // {§oauth-issuer} Without a configured issuer, naming one is the working form.
            throw new OAuthSetupError("oauth-metadata-unavailable",
                "MCP OAuth requires validated authorization-server metadata, and the server provided none.",
                this.#issuer === undefined ? "Name the authorization server as the definition's authorization.issuer." : undefined,
            );
        }
        this.#discoveryState = state;
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        if (!this.#awaitingAuthorizationCallback && this.#presentedToken) {
            this.#presentedToken = false;
            this.#discoveryState = undefined;
        }
        // {§oauth-issuer} A configured issuer is where discovery starts, whatever the resource publishes.
        return this.#discoveryState ?? (this.#issuer === undefined ? undefined : { authorizationServerUrl: this.#issuer });
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        const grant = this.grant;
        if ((scope === "all" || scope === "client") && grant.activeIssuer !== undefined) {
            grant.clientInformation.delete(grant.activeIssuer);
        }
        if (scope === "all" || scope === "tokens") {
            if (grant.activeIssuer !== undefined) grant.tokens.delete(grant.activeIssuer);
            grant.currentTokens = undefined;
            this.#presentedToken = false;
        }
        if (scope === "all" || scope === "verifier") {
            this.#codeVerifier = undefined;
            this.#awaitingAuthorizationCallback = false;
        }
        if (scope === "all" || scope === "discovery") this.#discoveryState = undefined;
    }
}
