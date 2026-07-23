// The MOCK-tier test bootstrap (unit + intg), loaded via `node --import=./test/setup.ts`.
//
// These tiers inject Mock providers with tiny FAKE context windows (many at 8192, some at 1) to
// exercise the budget grinder and overflow paths. That is a TEST-FIXTURE concern, NOT a model
// config: it needs small reserves so a fake 8192 window has prompt room, and it must be identical
// on every checkout. So it lives here — committed and authoritative (an --import module runs AFTER
// --env-file, so it wins) — never in .env.test (operator-local, and it would collide with the real
// model's own reserves) and never hardcoded per-tier in package.json.
//
// The REAL models (turboderp, gbuild) carry their ONE real config as PLURNK_*_<alias> knobs in
// .env; the live/demo tiers select one via PLURNK_MODEL in .env.test and pivot casually. This
// bootstrap is the Mock tier's parallel: a fake `mocktest` alias (Mocks are injected, so it's never
// dialed) with fixture-scaled reserves that no real model ever sees.
const fixture = {
    // A fake alias — never dialed (the tests inject Mock providers); it only gives the
    // alias-scoped machinery a stable name whose bare partition (below) governs.
    PLURNK_MODEL: "mocktest",
    PLURNK_MODEL_mocktest: "openai/mocktest",
    // Reserves scaled for fake Mock windows: a 8192-token Mock can't fit a real model's ~13312 of
    // reserves, so prompt budget must stay positive. `mocktest` has no per-alias override, so this
    // bare partition is what resolves for it — real models' PLURNK_SERVICE_*_<alias> never apply.
    // #507 — the envelope is provider-owned; Mock reads the bare _RESERVE knobs and takes its
    // window from the constructor. 78848 (the old env window) is dead: each test's Mock declares.
    PLURNK_PROVIDERS_REASONING_RESERVE: "256",
    PLURNK_PROVIDERS_COMPLETION_RESERVE: "1024",
    PLURNK_SERVICE_SAFETY: "64",
    // Test isolation, tier-wide: no operator doc-foist, no operator system policy, a bounded turn
    // ceiling so a wandering green loop still ends legibly, a scratch DB. Vector-ranking suites
    // re-enable the embedder per-file (they delete PLURNK_SERVICE_EMBED_DISABLE in their own setup).
    PLURNK_SERVICE_MD_POLICY: "",
    PLURNK_SERVICE_POLICY: "",
    PLURNK_SERVICE_EMBED_DISABLE: "1",
    // Production sizes semantic work from the host. The deterministic suite runs several
    // processes concurrently, so each process receives a deliberately small resource budget.
    PLURNK_MIMETYPES_EMBED_WORKERS: "1",
    PLURNK_SERVICE_DERIVE_CONCURRENCY: "1",
    PLURNK_SERVICE_MAX_TURNS: "50",
    PLURNK_SERVICE_DB_PATH: "./plurnk.test.db",
    PLURNK_PORT: "3045",
} as const;

for (const [key, value] of Object.entries(fixture)) process.env[key] = value;

// The assembled floor rides after the fixture (set-if-unset — the fixture wins; siblings'
// defaults fill the rest). Live/demo load ./floor.ts directly, without this Mock fixture.
await import("./floor.ts");
