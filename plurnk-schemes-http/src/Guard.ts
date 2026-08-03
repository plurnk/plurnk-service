// Typed facade and guarded redirect transport for the package-owned admission
// broker {§http-security-boundary}.

import type { Dispatcher } from "undici";
import {
    admissionBroker,
    type AdmissionBoundary,
} from "./AdmissionBroker.ts";
import { requireNumEnv } from "./Browser.ts";
import {
    GuardBlockedError,
    GuardResolutionError,
    isPublicAddress,
    type GuardAdmission,
} from "./NetworkPolicy.ts";

export {
    GuardBlockedError,
    GuardResolutionError,
};
export type { GuardAdmission };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = new Set(["content-encoding", "content-language", "content-location", "content-type"]);
const AUTHORIZATION_HEADERS = new Set(["authorization"]);

const withoutHeaders = (
    headers: ReadonlyArray<readonly [string, string]>,
    names: ReadonlySet<string>,
): Array<[string, string]> => headers
    .filter(([name]) => !names.has(name.toLowerCase()))
    .map(([name, value]) => [name, value]);

type BrokeredRequestInit = RequestInit & { dispatcher: Dispatcher };

export default class Guard {
    static isPublicAddress(ip: string): boolean {
        return isPublicAddress(ip);
    }

    static admit(
        raw: string,
        boundary: AdmissionBoundary = admissionBroker,
    ): Promise<GuardAdmission> {
        return boundary.admit(raw);
    }

    static async fetch(
        raw: string,
        init: { method: string; body: string | undefined; headers: ReadonlyArray<readonly [string, string]> },
        signal: AbortSignal,
        boundary: AdmissionBoundary = admissionBroker,
    ): Promise<Response> {
        let target = raw;
        let method = init.method;
        let body = init.body;
        let headers = init.headers.map(([name, value]): [string, string] => [name, value]);
        let hops = requireNumEnv("PLURNK_SCHEMES_HTTP_REDIRECTS");
        while (true) {
            let current: URL;
            try {
                current = new URL(target);
            } catch {
                throw new GuardBlockedError(target);
            }
            if (!["http:", "https:"].includes(current.protocol)) throw new GuardBlockedError(current.href);
            const admission = await Guard.admit(current.href, boundary);
            if (!admission.admitted) throw admission.error;
            let response: Response;
            try {
                response = await fetch(current.href, {
                    method,
                    body,
                    headers,
                    signal,
                    redirect: "manual",
                    dispatcher: await boundary.legacyDispatcher(),
                } as BrokeredRequestInit);
            } catch (cause) {
                throw boundary.translateTransportError(current.href, cause);
            }
            if (!REDIRECT_STATUSES.has(response.status)) return response;
            const location = response.headers.get("location");
            if (location === null || hops <= 0) return response;
            await response.body?.cancel();
            hops -= 1;
            const next = new URL(location, current);
            if (((response.status === 301 || response.status === 302) && method === "POST")
                || (response.status === 303 && method !== "GET" && method !== "HEAD")) {
                method = "GET";
                body = undefined;
                headers = withoutHeaders(headers, BODY_HEADERS);
            }
            if (current.origin !== next.origin) headers = withoutHeaders(headers, AUTHORIZATION_HEADERS);
            target = next.href;
        }
    }
}
