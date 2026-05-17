// Daemon's method + notification registry. Methods are JSON-RPC endpoints
// the daemon exposes; notifications are server-initiated events the daemon
// may emit. Both have metadata that surfaces via `discover` (SPEC §13.4).

import type { DatabaseSync } from "node:sqlite";
import type { ClientEnvelope } from "./envelope.ts";

export type NotifyTarget = "this" | "all";

export type MethodHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

export interface HandlerContext {
    registry: MethodRegistry;
    db: DatabaseSync;
    session: ClientEnvelope | null;
    attachSession: (envelope: ClientEnvelope) => void;
    notify: (target: NotifyTarget, method: string, params?: unknown) => void;
}

export interface MethodRegistration {
    handler: MethodHandler;
    description: string;
    params?: Record<string, string>;
    requiresInit?: boolean;
    longRunning?: boolean;
}

export interface NotificationRegistration {
    description: string;
    params?: Record<string, string>;
}

export interface MethodCatalogEntry {
    description: string;
    params: Record<string, string>;
    requiresInit: boolean;
    longRunning: boolean;
}

export interface NotificationCatalogEntry {
    description: string;
    params: Record<string, string>;
}

export interface Catalog {
    protocolVersion: string;
    methods: Record<string, MethodCatalogEntry>;
    notifications: Record<string, NotificationCatalogEntry>;
}

const PROTOCOL_VERSION = "0.1.0";

export default class MethodRegistry {
    #methods = new Map<string, MethodRegistration>();
    #notifications = new Map<string, NotificationRegistration>();

    registerMethod(name: string, registration: MethodRegistration): void {
        if (this.#methods.has(name)) {
            throw new Error(`method '${name}' is already registered`);
        }
        this.#methods.set(name, registration);
    }

    registerNotification(name: string, registration: NotificationRegistration): void {
        if (this.#notifications.has(name)) {
            throw new Error(`notification '${name}' is already registered`);
        }
        this.#notifications.set(name, registration);
    }

    getMethod(name: string): MethodRegistration | undefined {
        return this.#methods.get(name);
    }

    hasMethod(name: string): boolean {
        return this.#methods.has(name);
    }

    hasNotification(name: string): boolean {
        return this.#notifications.has(name);
    }

    listMethods(): string[] {
        return [...this.#methods.keys()].toSorted();
    }

    listNotifications(): string[] {
        return [...this.#notifications.keys()].toSorted();
    }

    catalog(): Catalog {
        const methods: Record<string, MethodCatalogEntry> = {};
        for (const [name, reg] of this.#methods.entries()) {
            methods[name] = {
                description: reg.description,
                params: reg.params ?? {},
                requiresInit: reg.requiresInit ?? false,
                longRunning: reg.longRunning ?? false,
            };
        }
        const notifications: Record<string, NotificationCatalogEntry> = {};
        for (const [name, reg] of this.#notifications.entries()) {
            notifications[name] = {
                description: reg.description,
                params: reg.params ?? {},
            };
        }
        return { protocolVersion: PROTOCOL_VERSION, methods, notifications };
    }
}
