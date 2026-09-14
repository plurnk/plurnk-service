import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import { UNKNOWN_POSITION, Validator } from "./index.ts";
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };

test("ProposalProjection's operation enum is the closed runtime alphabet", () => {
    assert.deepEqual(proposalProjectionSchema.properties.op.enum, Contracts.PLURNK_OPS);
});

test("the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).sort(), [
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
        "InvalidTextRegionError",
        "PLURNK_OPS",
        "PathSyntax",
        "PlanValue",
        "PlurnkParseError",
        "Problems",
        "REASONING_POLICIES",
        "RESERVED_AUTHORITIES",
        "TurnDisposition",
        "UNKNOWN_POSITION",
        "Validator",
        "WORKER_NAME",
        "aguiConformanceReport",
        "formatJsonDocument",
        "lifecycleOfLoopStatus",
        "renderJsonResult",
    ]);
});

test("unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
    assert.equal(Validator.validatePosition(UNKNOWN_POSITION).valid, true);
});
