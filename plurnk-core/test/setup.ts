// The MOCK-tier test bootstrap (unit + intg), loaded via `node --import=./test/setup.ts`.
//
// These tiers inject Mock providers with tiny FAKE context windows (many at 8192, some at 1) to
// exercise the budget overflow recovery and overflow paths. That is a TEST-FIXTURE concern, NOT a model
// config: it needs small reserves so a fake 8192 window has prompt room, and it must be identical
// on every checkout. So it lives here — committed and authoritative (an --import module runs AFTER
// --env-file, so it wins) — never in the real-model .env.test profile (it would collide with the
// selected model's own reserves) and never hardcoded per-tier in package.json.
//
// The REAL models (turboderp, gbuild) carry their ONE real config as PLURNK_*_<alias> knobs in
// operator env or the shell; the committed .env.test selects turboderp as its safe gate default.
// This bootstrap is the Mock tier's parallel and overrides that selection with a fake `mocktest`
// alias (Mocks are injected, so it's never dialed) whose fixture-scaled reserves no real model sees.
const fixture = {
    // A fake alias — never dialed (the tests inject Mock providers); it only gives the
    // alias-scoped machinery a stable name whose bare partition (below) governs.
    PLURNK_MODEL: "mocktest",
    PLURNK_MODEL_mocktest: "openai/mocktest",
    // A fixture-sized total output envelope leaves room in tiny Mock windows.
    // Reasoning is a subset of that total, never an additive reserve.
    PLURNK_PROVIDERS_OUTPUT_BUDGET: "1280",
    PLURNK_PROVIDERS_REASONING_BUDGET: "256",
    // Test isolation, tier-wide: no operator doc-foist, no operator system policy, a bounded turn
    // ceiling so a wandering green loop still ends legibly, a scratch DB. Vector-ranking suites
    // re-enable the embedder per-file (they delete PLURNK_SERVICE_EMBED_DISABLE in their own setup).
    PLURNK_SERVICE_MD_POLICY: "",
    PLURNK_SERVICE_POLICY: "",
    PLURNK_SERVICE_EMBED_DISABLE: "1",
    // Suites that re-enable the embedder embed with the bundled runtime: an ambient operator
    // route (a GPU llama-server, a hosted endpoint) never becomes a gate dependency.
    PLURNK_EMBEDDING_MODEL: "",
    // Production sizes semantic work from the host. The deterministic suite runs several
    // processes concurrently, so each process receives a deliberately small resource budget.
    PLURNK_EMBEDDING_WORKERS: "1",
    PLURNK_SERVICE_DERIVE_CONCURRENCY: "1",
    PLURNK_SERVICE_MAX_TURNS: "50",
    // {§provider-recovery} — the Mock tier exercises recovery in milliseconds: a persistent
    // provider failure parks a loop after 1.5 s of 20 ms-based backoff instead of fifteen minutes.
    PLURNK_SERVICE_PROVIDER_RECOVERY: "1500",
    PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "20",
    PLURNK_SERVICE_DB_PATH: "./plurnk.test.db",
    PLURNK_PORT: "3045",
} as const;

for (const [key, value] of Object.entries(fixture)) process.env[key] = value;

// The assembled floor rides after the fixture (set-if-unset — the fixture wins; siblings'
// defaults fill the rest). Live/demo load ./floor.ts directly, without this Mock fixture.
await import("./floor.ts");
