import test from "node:test";
import assert from "node:assert/strict";
import * as Contracts from "./index.ts";
import { UNKNOWN_POSITION, Validator } from "./index.ts";
import proposalProjectionSchema from "../schema/ProposalProjection.json" with { type: "json" };

test("{§contract-proposal-projection} ProposalProjection's op keywords are the closed operation alphabet; a runtime tag is the other branch", () => {
    assert.deepEqual(proposalProjectionSchema.properties.op.anyOf[0].enum, Contracts.PLURNK_OPS);
    assert.equal(proposalProjectionSchema.properties.op.anyOf[1].pattern, Contracts.RUNTIME_TAG.source);
});

test("{§root-value-api} the package root exposes exactly the supported runtime values", () => {
    assert.deepEqual(Object.keys(Contracts).toSorted(), [
        "APPLICATION_NOTIFICATIONS",
        "CapabilityAdmission",
        "EFFORTS",
        "INTERNAL_ROW_OPS",
        "InvalidA2aAgentDefinitionError",
        "InvalidAcpClientConformanceError",
        "InvalidAcpConformanceKitError",
        "InvalidAcpDiscoveryError",
        "InvalidCapabilityDescriptorError",
        "InvalidCapabilityPolicyError",
        "InvalidClientDisplayCapabilitiesError",
        "InvalidClientInteractionProjectionError",
        "InvalidClientInteractionRequestError",
        "InvalidClientInteractionResolutionError",
        "InvalidEffortError",
        "InvalidEntryReadResultError",
        "InvalidFunctionalityDiscoverResultError",
        "InvalidFunctionalityListResultError",
        "InvalidFunctionalityMutationResultError",
        "InvalidJsonSchemaInstanceError",
        "InvalidMcpOAuthError",
        "InvalidMcpServerDefinitionError",
        "InvalidModelCatalogPageError",
        "InvalidModelCatalogQueryError",
        "InvalidModelReadinessError",
        "InvalidModelRouteError",
        "InvalidNoticeError",
        "InvalidOperationResultError",
        "InvalidParsedPathError",
        "InvalidPlurnkStatementError",
        "InvalidProblemDetailsError",
        "InvalidProblemProjectionError",
        "InvalidProposalProjectionError",
        "InvalidRangeExtentError",
        "InvalidRollbackReportError",
        "InvalidSkillDefinitionError",
        "InvalidTextRegionError",
        "InvalidWorkerOwnerError",
        "MAX_TIMER_MS",
        "PLURNK_FENCE",
        "PLURNK_OPS",
        "PROPOSAL_POLICIES",
        "PathSyntax",
        "PlurnkParseError",
        "Problems",
        "RUNTIME_TAG",
        "SKILL_NAME",
        "TurnDisposition",
        "UNKNOWN_POSITION",
        "Validator",
        "WORKER_NAME",
        "acpConformanceReport",
        "addressOf",
        "errnoCode",
        "excerptOf",
        "formatJsonDocument",
        "isExecution",
        "isExecutionOp",
        "isLogEntryNotification",
        "isPlurnkOp",
        "isRecord",
        "isSafeInteger",
        "lifecycleOfLoopStatus",
        "renderJsonResult",
        "requestOrigin",
        "selectWorkerLoop",
        "withoutBodies",
        "writtenOp",
    ]);
});

test("{§canonical-statement} isPlurnkOp admits the operation alphabet and nothing else", () => {
    for (const op of Contracts.PLURNK_OPS) assert.equal(Contracts.isPlurnkOp(op), true, op);
    for (const other of ["find", "Read", "sh", "extension", "error", "", " FIND", null, undefined, 7, ["FIND"]]) {
        assert.equal(Contracts.isPlurnkOp(other), false, JSON.stringify(other));
    }
});

test("{§parser-position} unknown statement position is one frozen contracts-owned value", () => {
    assert.deepEqual(UNKNOWN_POSITION, { line: 0, column: 0 });
    assert.equal(Object.isFrozen(UNKNOWN_POSITION), true);
    assert.equal(Validator.validatePosition(UNKNOWN_POSITION).valid, true);
});
