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

test("{§tokenomics-calibrated-readout} scaled inventory figures round and never show zero", () => {
    assert.deepEqual(TokenCalibration.scale({ path: "log:///1/2/3/READ", tokensBody: 3, tokensActive: 1 }, 0.2), { path: "log:///1/2/3/READ", tokensBody: 1, tokensActive: 1 });
    assert.deepEqual(TokenCalibration.scale({ path: "log:///1/2/3/READ", tokensBody: 1000, tokensActive: 1200 }, 0.65), { path: "log:///1/2/3/READ", tokensBody: 650, tokensActive: 780 });
});
