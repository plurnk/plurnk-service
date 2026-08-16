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
    readonly clientMetadataUrl: string;
    readonly #scope: string | undefined;
    readonly #state = randomUUID();
    #authorizationUrl: URL | undefined;
    #clientInformation: StoredOAuthClientInformation | undefined;
    #tokens: StoredOAuthTokens | undefined;
    #codeVerifier: string | undefined;
    #discoveryState: OAuthDiscoveryState | undefined;

    constructor({
        redirectUrl,
        clientMetadataUrl,
        scope,
    }: {
        redirectUrl: string;
        clientMetadataUrl: string;
        scope?: string;
    }) {
        this.redirectUrl = redirectUrl;
        this.clientMetadataUrl = clientMetadataUrl;
        this.#scope = scope;
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
        return this.#state;
    }

    clientInformation(
        _context?: OAuthClientInformationContext,
    ): StoredOAuthClientInformation | undefined {
        return this.#clientInformation;
    }

    saveClientInformation(
        clientInformation: StoredOAuthClientInformation,
        _context?: OAuthClientInformationContext,
    ): void {
        this.#clientInformation = clientInformation;
    }

    tokens(_context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
        return this.#tokens;
    }

    saveTokens(tokens: StoredOAuthTokens, _context?: OAuthClientInformationContext): void {
        this.#tokens = tokens;
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this.#authorizationUrl = authorizationUrl;
    }

    authorizationUrl(): URL | undefined {
        return this.#authorizationUrl;
    }

    assertCallbackState(callback: URL): void {
        if (callback.searchParams.get("state") !== this.#state) {
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
        this.#discoveryState = state;
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.#discoveryState;
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        if (scope === "all" || scope === "client") this.#clientInformation = undefined;
        if (scope === "all" || scope === "tokens") this.#tokens = undefined;
        if (scope === "all" || scope === "verifier") this.#codeVerifier = undefined;
        if (scope === "all" || scope === "discovery") this.#discoveryState = undefined;
    }
}
