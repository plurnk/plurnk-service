// {§agui-oauth-documents} — the documents the authorization server shows a person: semantic HTML with
// no script and no class, readable on their own, and styled by a module client's registered stylesheet
// on that client's requests. Pure: the server decides which document and which stylesheet.

export interface AuthorizationDocument {
    readonly title: string;
    readonly body: string;
}

export const escapeHtml = (value: string): string => value
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");

const WARNING = `<span role="img" aria-label="Warning">⚠</span>`;
const page = (heading: string, content: string, warning = false): string =>
    `<main><article><header><h1>${warning ? `${WARNING} ` : ""}${heading}</h1></header>${content}</article></main>`;
const SETTINGS = "<p>Set it in the operator's configuration file, <code>$XDG_CONFIG_HOME/plurnk/.env</code>, which is "
    + "<code>~/.config/plurnk/.env</code> by default, and restart the daemon.</p>";

// What the request asks, and the request itself carried forward through the document's forms.
export interface AuthorizationRequest {
    readonly client: string;
    readonly scopes: readonly string[];
    readonly hidden: Readonly<Record<string, string>>;
}

const asks = (request: AuthorizationRequest): string =>
    `<p><strong>${escapeHtml(request.client)}</strong> asks to use this daemon (scope: ${escapeHtml(request.scopes.join(" "))}).</p>`;
const carried = (hidden: Readonly<Record<string, string>>): string => Object.entries(hidden)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");

export const AuthorizationDocuments = {
    signIn: (request: AuthorizationRequest, failure: string | null): AuthorizationDocument => ({
        title: "Plurnk: sign in",
        body: page("Sign in to Plurnk", asks(request)
            + (failure === null ? "" : `<p role="alert">${WARNING} ${escapeHtml(failure)}</p>`)
            + `<form method="post" action="/oauth/authorize">${carried(request.hidden)}`
            + `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>`
            + `<button type="submit">Continue</button></form>`),
    }),
    consent: (request: AuthorizationRequest): AuthorizationDocument => ({
        title: "Plurnk: allow access?",
        body: page("Allow access?", asks(request)
            + `<form method="post" action="/oauth/authorize">${carried(request.hidden)}`
            + `<button type="submit" name="consent" value="allow">Allow</button> <button type="submit" name="consent" value="deny">Deny</button></form>`),
    }),
    noPassword: (): AuthorizationDocument => ({
        title: "Plurnk: no password is set",
        body: page("No password is set", "<p>A browser signs in to this daemon with the operator's password, and <code>PLURNK_PASS</code> is empty.</p>"
            + SETTINGS
            + "<p>Until then no browser can sign in. The terminal client and your other tools sign in with the operator's secret and are unaffected.</p>", true),
    }),
    refused: (): AuthorizationDocument => ({
        title: "Plurnk: request refused",
        body: page("Request refused", "<p>The client or its redirect address is not registered with this daemon.</p>", true),
    }),
    signedIn: (hidden: Readonly<Record<string, string>>): AuthorizationDocument => ({
        title: "Plurnk: signed in",
        body: page("Signed in", "<p>This browser is signed in to this daemon as the operator.</p>"
            + `<form method="post" action="/oauth/session">${carried(hidden)}<button type="submit" name="action" value="end">Sign out</button></form>`),
    }),
    notSignedIn: (): AuthorizationDocument => ({
        title: "Plurnk: not signed in",
        body: page("Not signed in", "<p>This browser holds no session with this daemon.</p>"),
    }),
    signedOut: (): AuthorizationDocument => ({
        title: "Plurnk: signed out",
        body: page("Signed out", "<p>This browser no longer holds a session with this daemon.</p>"),
    }),
};

// Readable alone in either color scheme; replaced, never overridden, by a registered stylesheet.
const STANDALONE = ":root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:28rem;padding:0 1rem}"
    + "label{display:block;margin:.75rem 0 .25rem}input{width:100%;box-sizing:border-box;padding:.5rem}button{margin-top:1rem;padding:.5rem 1rem}"
    + "[role=alert]{color:#b3261e}@media (prefers-color-scheme:dark){[role=alert]{color:#f2b8b5}}";

/**
 * {§agui-oauth-documents} The complete document and its content security policy: the registered
 * stylesheet, same-origin, in place of the standalone style when one applies.
 */
export const renderAuthorizationDocument = (document: AuthorizationDocument, stylesheet: string | null): { readonly html: string; readonly policy: string } => ({
    html: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
        + `<title>${escapeHtml(document.title)}</title>`
        + (stylesheet === null ? `<style>${STANDALONE}</style>` : `<link rel="stylesheet" href="${escapeHtml(stylesheet)}">`)
        + `</head><body>${document.body}</body></html>\n`,
    policy: `default-src 'none'; style-src ${stylesheet === null ? "'unsafe-inline'" : "'self'"}; form-action 'self'; frame-ancestors 'none'`,
});

/**
 * {§agui-oauth-documents} Every document the authorization server serves, rendered with placeholder
 * values, for a consumer whose production CSS pruning must keep the selectors they use.
 */
export const authorizationDocumentSpecimens = (): readonly string[] => {
    const request: AuthorizationRequest = { client: "client", scopes: ["agui"], hidden: { client_id: "client", state: "state" } };
    return [
        AuthorizationDocuments.signIn(request, null),
        AuthorizationDocuments.signIn(request, "The password is wrong."),
        AuthorizationDocuments.consent(request),
        AuthorizationDocuments.noPassword(),
        AuthorizationDocuments.refused(),
        AuthorizationDocuments.signedIn({ client_id: "client" }),
        AuthorizationDocuments.notSignedIn(),
        AuthorizationDocuments.signedOut(),
    ].map((document) => document.body);
};
