// {§credential-module-client} — the composed boot: a consumer module registers its confidential
// client at setup knowing no origin, set up before the client interface or after it, and is answered
// at its path on the issuer, under the address its request reached on an ephemeral port and under a
// configured public one.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { Module as AguiModule } from "@plurnk/plurnk-agui";
import Daemon from "../../src/server/Daemon.ts";
import { bindListener } from "./_a2a.ts";
import { openMigrated } from "./_db.ts";

const CALLBACK = "/consumer/callback";
const STYLESHEET = "/consumer/authority.css";

// A module of this daemon as a consumer writes one: it claims a mount, registers its client at setup
// with the path alone, reads the face at start, and serves its callback on its own mount.
const consumer = () => {
    const seen = { secret: "", facePublishedAtSetup: false, issuerAtStart: "", codes: [] as string[] };
    const module = {
        mounts: ["/consumer"],
        setup: (seam: Pick<ApplicationPort, "credentials">): void => {
            seen.facePublishedAtSetup = seam.credentials.face() !== null;
            seen.secret = seam.credentials.registerClient({ id: "consumer", redirectPaths: [CALLBACK], scopes: ["agui"], stylesheetPath: STYLESHEET }).clientSecret;
        },
        start: (port: ApplicationPort): void => {
            seen.issuerAtStart = port.credentials.face()!.issuer();
            port.registerHttpRoute("/consumer", (req, res) => {
                const url = new URL(req.url ?? "/", "http://consumer");
                if (url.pathname === CALLBACK) seen.codes.push(url.searchParams.get("code") ?? "");
                res.writeHead(url.pathname === CALLBACK ? 200 : 404);
                res.end();
            });
        },
    };
    return { module, seen };
};

for (const order of ["the consumer set up first", "the client interface set up first"] as const) {
    for (const issuer of ["", "https://plurnk.example"] as const) {
        const origin = issuer === "" ? "the address the request reached, on an ephemeral port" : "a configured issuer";
        test(`{§credential-module-client} ${order}, ${origin}: a module registers at setup and is answered at its path on the issuer`, async (t) => {
            const db = await openMigrated();
            const http = await bindListener();
            const daemon = new Daemon({ db, provider: null, http });
            t.after(async () => {
                await daemon.stop();
                await http.close();
                await db.close();
            });
            const { module, seen } = consumer();
            const client = AguiModule.create({ auth: true, issuer, password: "composed" });
            if (order === "the consumer set up first") {
                daemon.registerModule(module, "@acme/consumer");
                daemon.registerModule(client, "@plurnk/plurnk-agui");
            } else {
                daemon.registerModule(client, "@plurnk/plurnk-agui");
                daemon.registerModule(module, "@acme/consumer");
            }
            await daemon.start();

            const base = `http://127.0.0.1:${http.httpAddress().port}`;
            const expected = issuer === "" ? base : issuer;
            assert.equal(seen.facePublishedAtSetup, order === "the client interface set up first", "registration waited on no other module");
            assert.equal(seen.issuerAtStart, expected, "{§credential-authority}: the face answers its issuer in a module's start");

            const redirect = `${expected}${CALLBACK}`;
            const verifier = randomBytes(32).toString("base64url");
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ client_id: "consumer", redirect_uri: redirect, response_type: "code", scope: "agui", code_challenge: challenge, code_challenge_method: "S256" })}`);
            assert.ok((await page.text()).includes(`<link rel="stylesheet" href="${STYLESHEET}">`), "{§agui-oauth-documents}: the module's own stylesheet on the page it is signed in at");
            // The operator signs in at the authorization endpoint, which answers the consumer's client at once.
            const authorized = await fetch(`${base}/oauth/authorize`, {
                method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: "consumer", redirect_uri: redirect, response_type: "code", scope: "agui", state: "s",
                    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
                    password: "composed",
                }).toString(),
            });
            assert.equal(authorized.status, 302, await authorized.text());
            const location = new URL(authorized.headers.get("location")!);
            assert.equal(`${location.origin}${location.pathname}`, redirect, "answered at the module's path on the issuer");
            const code = location.searchParams.get("code")!;

            // The browser follows the redirect; whatever fronts a configured issuer forwards the path here.
            assert.equal((await fetch(`${base}${location.pathname}${location.search}`)).status, 200);
            assert.deepEqual(seen.codes, [code], "the module's own mount received the code");

            const exchanged = await fetch(`${base}/oauth/token`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`consumer:${seen.secret}`).toString("base64")}` },
                body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier }).toString(),
            });
            const body = await exchanged.text();
            assert.equal(exchanged.status, 200, body);
            const claims = daemon.credentials.verify((JSON.parse(body) as { access_token: string }).access_token);
            assert.deepEqual([claims?.kind, claims?.clientId, claims?.scopes], ["access", "consumer", ["agui"]]);
        });
    }
}
