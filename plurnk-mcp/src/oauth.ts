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

export default class InteractiveOAuthProvider implements OAuthClientProvider {
    readonly redirectUrl: string;
    readonly clientMetadataUrl: string | undefined;
    readonly #scope: string | undefined;
    readonly #configuredClientInformation: StoredOAuthClientInformation | undefined;
    readonly #clientInformation = new Map<string, StoredOAuthClientInformation>();
    readonly #tokens = new Map<string, StoredOAuthTokens>();
    #configuredIssuer: string | undefined;
    #activeIssuer: string | undefined;
    #currentTokens: StoredOAuthTokens | undefined;
    #presentedToken = false;
    #awaitingAuthorizationCallback = false;
    #state: string | undefined;
    #authorizationUrl: URL | undefined;
    #codeVerifier: string | undefined;
    #discoveryState: OAuthDiscoveryState | undefined;

    constructor({
        redirectUrl,
        clientMetadataUrl,
        clientId,
        clientSecret,
        scope,
    }: {
        redirectUrl: string;
        clientMetadataUrl?: string;
        clientId?: string;
        clientSecret?: string;
        scope?: string;
    }) {
        this.redirectUrl = redirectUrl;
        this.clientMetadataUrl = clientMetadataUrl;
        this.#scope = scope;
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
        const issuer = context?.issuer ?? this.#activeIssuer;
        if (issuer === undefined) return undefined;
        this.#activeIssuer = issuer;
        const stored = this.#clientInformation.get(issuer);
        if (stored !== undefined) return stored;
        if (
            this.#configuredClientInformation === undefined
            || (this.#configuredIssuer !== undefined && this.#configuredIssuer !== issuer)
        ) {
            const metadata = this.#discoveryState?.authorizationServerMetadata;
            const cimdAvailable = this.clientMetadataUrl !== undefined
                && metadata?.client_id_metadata_document_supported === true;
            if (!cimdAvailable && metadata?.registration_endpoint === undefined) {
                throw new Error(
                    `MCP authorization server '${issuer}' exposes no usable client registration: `
                    + "configure pre-registration or advertised CIMD; its metadata does not advertise "
                    + "a Dynamic Client Registration endpoint.",
                );
            }
            return undefined;
        }
        this.#configuredIssuer = issuer;
        const configured = { ...this.#configuredClientInformation, issuer };
        this.#clientInformation.set(issuer, configured);
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
        this.#activeIssuer = issuer;
        this.#clientInformation.set(issuer, { ...clientInformation, issuer });
    }

    tokens(context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
        if (context === undefined) {
            this.#presentedToken = this.#currentTokens !== undefined;
            return this.#currentTokens;
        }
        this.#activeIssuer = context.issuer;
        return this.#tokens.get(context.issuer);
    }

    saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): void {
        const issuer = context?.issuer ?? tokens.issuer;
        if (issuer === undefined) {
            throw new Error("MCP OAuth tokens are missing their authorization-server issuer.");
        }
        const stored = { ...tokens, issuer };
        this.#activeIssuer = issuer;
        this.#currentTokens = stored;
        this.#presentedToken = false;
        this.#awaitingAuthorizationCallback = false;
        this.#tokens.set(issuer, stored);
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.#awaitingAuthorizationCallback = true;
        this.#authorizationUrl = authorizationUrl;
    }

    takeAuthorizationUrl(): URL | undefined {
        const authorizationUrl = this.#authorizationUrl;
        this.#authorizationUrl = undefined;
        return authorizationUrl;
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
            throw new Error(
                "MCP OAuth requires validated authorization-server metadata; "
                + "legacy endpoint inference is not supported.",
            );
        }
        this.#discoveryState = state;
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        if (!this.#awaitingAuthorizationCallback && this.#presentedToken) {
            this.#presentedToken = false;
            this.#discoveryState = undefined;
        }
        return this.#discoveryState;
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        if ((scope === "all" || scope === "client") && this.#activeIssuer !== undefined) {
            this.#clientInformation.delete(this.#activeIssuer);
        }
        if (scope === "all" || scope === "tokens") {
            if (this.#activeIssuer !== undefined) this.#tokens.delete(this.#activeIssuer);
            this.#currentTokens = undefined;
            this.#presentedToken = false;
        }
        if (scope === "all" || scope === "verifier") {
            this.#codeVerifier = undefined;
            this.#awaitingAuthorizationCallback = false;
        }
        if (scope === "all" || scope === "discovery") this.#discoveryState = undefined;
    }
}
