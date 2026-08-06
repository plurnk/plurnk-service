// Low-cardinality metric recording at the observational boundary
// ({§observability-boundary}). Counters are acquired lazily at record time so
// an SDK registered after import is honored; the default no-op meter makes an
// unconfigured process cost nothing. Labels stay low-cardinality: statuses, op
// families, models, attempts — never identifiers or content.

import { serviceMeter } from "./api.ts";

export const recordCounter = (name: string, attributes: Record<string, string | number>): void => {
    // The SDK meter caches instruments by name; the no-op meter is a cheap call.
    serviceMeter().createCounter(name).add(1, attributes);
};

export const LOOP_TERMINALS = "plurnk.loop.terminals";
export const TURNS_COMPLETED = "plurnk.turns.completed";
export const PROVIDER_CALLS = "plurnk.provider.calls";
export const OPS_DISPATCHED = "plurnk.ops.dispatched";
