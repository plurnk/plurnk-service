import test from "node:test";
import assert from "node:assert/strict";
import TokenCalibration from "./TokenCalibration.ts";

test("{§tokenomics-calibrated-readout} fewer than three samples keep the factor at 1", () => {
    assert.equal(TokenCalibration.factor([]), 1);
    assert.equal(TokenCalibration.factor([{ weight: 100, reported: 60 }, { weight: 100, reported: 60 }]), 1);
});

test("{§tokenomics-calibrated-readout} the factor is reported over measured, summed across the samples", () => {
    const factor = TokenCalibration.factor([{ weight: 100, reported: 60 }, { weight: 200, reported: 140 }, { weight: 100, reported: 60 }]);
    assert.equal(factor, 260 / 400);
});

test("{§tokenomics-calibrated-readout} a sample that is not a positive integer is refused", () => {
    assert.throws(() => TokenCalibration.factor([{ weight: 100, reported: 0 }, { weight: 100, reported: 60 }, { weight: 100, reported: 60 }]), /calibration sample reported must be a positive safe integer/u);
    assert.throws(() => TokenCalibration.factor([{ weight: 1.5, reported: 1 }, { weight: 100, reported: 60 }, { weight: 100, reported: 60 }]), /calibration sample weight must be a positive safe integer/u);
});

test("{§tokenomics-calibrated-readout} only capacity crosses from provider tokens into curation units", () => {
    assert.equal(TokenCalibration.capacity(100_000), 100_000, "cold-start conversion is 1:1");
    assert.equal(TokenCalibration.capacity(100_000, 0.5), 200_000);
    assert.equal(TokenCalibration.capacity(100_000, 2), 50_000);
    assert.equal(TokenCalibration.capacity(10, 3), 3, "fractional curation units cannot enlarge the allowance");
    assert.equal(TokenCalibration.capacity(1, 2), 0, "no whole unit fits; never fabricate room");
    assert.equal(TokenCalibration.capacity(null, 0.5), null, "unknown physical capacity stays unknown");
});

test("{§tokenomics-calibrated-readout} invalid conversion inputs fail at the unit boundary", () => {
    for (const capacity of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => TokenCalibration.capacity(capacity), /input capacity must be a positive safe integer/u);
    }
    for (const factor of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => TokenCalibration.capacity(100, factor), /calibration must be a positive finite number/u);
    }
    assert.throws(() => TokenCalibration.capacity(Number.MAX_SAFE_INTEGER, 0.5), /curation capacity must be a non-negative safe integer/u);
});
