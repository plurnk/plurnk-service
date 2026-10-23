import test from "node:test";
import assert from "node:assert/strict";
import TokenCalibration from "./TokenCalibration.ts";

test("{§tokenomics-calibrated-readout} without a sample the offset is 0", () => {
    assert.equal(TokenCalibration.offset(undefined), 0);
});

test("{§tokenomics-calibrated-readout} one sample fixes the additive offset: measured weight minus reported tokens", () => {
    assert.equal(TokenCalibration.offset({ weight: 400, reported: 260 }), 140, "saved tokens on the measured packet credit the allowance");
    assert.equal(TokenCalibration.offset({ weight: 100, reported: 300 }), -200, "a denser tokenization deducts the observed overhead");
});

test("{§tokenomics-calibrated-readout} a sample that is not a positive integer is refused", () => {
    assert.throws(() => TokenCalibration.offset({ weight: 100, reported: 0 }), /calibration sample reported must be a positive safe integer/u);
    assert.throws(() => TokenCalibration.offset({ weight: 1.5, reported: 1 }), /calibration sample weight must be a positive safe integer/u);
});

test("{§tokenomics-calibrated-readout} capacity and estimatedTokens translate by the additive offset without extrapolating unmeasured content", () => {
    assert.equal(TokenCalibration.capacity(100_000), 100_000, "cold-start conversion is 1:1");
    assert.equal(TokenCalibration.capacity(100_000, 3_600), 103_600, "credits only the saved tokens actually observed");
    assert.equal(TokenCalibration.capacity(100_000, -5_000), 95_000, "deducts observed tokenization overhead");
    assert.equal(TokenCalibration.capacity(100, -250), 0, "no room fits; never fabricate negative capacity");
    assert.equal(TokenCalibration.capacity(null, 3_600), null, "unknown physical capacity stays unknown");

    assert.equal(TokenCalibration.estimatedTokens(9_000), 9_000);
    assert.equal(TokenCalibration.estimatedTokens(9_000, 3_600), 5_400, "at the measured weight, estimated tokens equal reported tokens");
    assert.equal(TokenCalibration.estimatedTokens(19_000, 3_600), 15_400, "unmeasured growth is budgeted 1:1");
    assert.equal(TokenCalibration.estimatedTokens(1_000, 3_600), 0, "clamps at zero when curated below the prior offset");
});

test("{§tokenomics-calibrated-readout} invalid conversion inputs fail at the unit boundary", () => {
    for (const capacity of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => TokenCalibration.capacity(capacity), /input capacity must be a positive safe integer/u);
    }
    for (const offset of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => TokenCalibration.capacity(100, offset), /calibration offset must be a safe integer/u);
        assert.throws(() => TokenCalibration.estimatedTokens(100, offset), /calibration offset must be a safe integer/u);
    }
    for (const weight of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => TokenCalibration.estimatedTokens(weight), /packet weight must be a non-negative safe integer/u);
    }
    assert.throws(() => TokenCalibration.capacity(Number.MAX_SAFE_INTEGER, 1), /curation capacity must be a non-negative safe integer/u);
    assert.throws(() => TokenCalibration.estimatedTokens(Number.MAX_SAFE_INTEGER, -1), /estimated tokens must be a non-negative safe integer/u);
});
