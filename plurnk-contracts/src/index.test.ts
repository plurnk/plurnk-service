import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import {
    PlurnkParser,
    Problems,
    UNKNOWN_POSITION,
    Validator,
} from "./index.ts";

test("the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).sort(), [
        "ACP_MEMORY_PREFIX",
        "AcpPlanValue",
        "CapabilityAdmission",
        "DEFAULT_CAPABILITY_POLICY",
        "DEFAULT_LOOP_POLICY",
        "DEFAULT_RETRIEVAL_LIMIT",
        "InvalidA2aAgentDefinitionError",
        "InvalidAguiClientConformanceError",
        "InvalidAguiConformanceKitError",
        "InvalidAguiDiscoveryError",
        "InvalidCapabilityDescriptorError",
        "InvalidCapabilityPolicyError",
        "InvalidClientDisplayCapabilitiesError",
        "InvalidClientInteractionProjectionError",
        "InvalidClientInteractionRequestError",
        "InvalidClientInteractionResolutionError",
        "InvalidEntryReadResultError",
        "InvalidFunctionalityDiscoverResultError",
        "InvalidFunctionalityListResultError",
        "InvalidFunctionalityMutationResultError",
        "InvalidJsonSchemaInstanceError",
        "InvalidLoopPolicyError",
        "InvalidMcpConfigurationOverlayError",
        "InvalidMcpServerDefinitionError",
        "InvalidMcpServerOptionsError",
        "InvalidModelCatalogPageError",
        "InvalidModelCatalogQueryError",
        "InvalidModelReadinessError",
        "InvalidModelRouteError",
        "InvalidNoticeError",
        "InvalidOperationResultError",
        "InvalidProblemDetailsError",
        "InvalidProblemProjectionError",
        "InvalidProposalProjectionError",
        "InvalidRangeExtentError",
        "InvalidReasoningPolicyError",
        "InvalidSkillDefinitionError",
        "InvalidTagSignalError",
        "InvalidTextRegionError",
        "PLURNK_OPS",
        "PathSyntax",
        "PlanValue",
        "PlurnkParseError",
        "PlurnkParser",
        "Problems",
        "REASONING_POLICIES",
        "RESERVED_AUTHORITIES",
        "TagSignal",
        "UNKNOWN_POSITION",
        "Validator",
        "WORKER_NAME",
        "aguiConformanceReport",
        "parsePath",
        "renderJsonResult",
    ]);
});

test("the package root is the singular language and wire-contract API", () => {
    const parsed = PlurnkParser.parseStatements("## EDIT0 (worker:///draft)\nbody");
    const item = parsed.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement") return;

    assert.equal(item.statement.op, "EDIT");
    assert.equal(Validator.validatePosition(item.statement.position).valid, true);

    const problem = Problems.create("contracts", "missing", 404, "Missing.");
    assert.equal(Validator.validateOperationResult({ status: 404, problem }).valid, true);
});

test("unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
    assert.equal(Validator.validatePosition(UNKNOWN_POSITION).valid, true);
});
