import { assert, describe, it } from "@effect/vitest";

import { ContextEstimateCalibration, type ContextCalibration } from "./contextCalibration.ts";

const projected = (input: Partial<ContextCalibration> = {}): ContextCalibration => ({
  usageTokens: 0,
  trailingTokens: 0,
  lastUsageIndex: null,
  tokens: 1_000,
  ...input,
});

describe("ContextEstimateCalibration", () => {
  it("applies an upward correction as soon as the anchored series has evidence", () => {
    const calibration = new ContextEstimateCalibration();
    assert.equal(calibration.trailingRatio(), 1);

    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 500, 2_000);
    }

    assert.equal(calibration.trailingRatio(), 2);
    assert.equal(
      calibration.correct(
        projected({ usageTokens: 1_000, trailingTokens: 500, lastUsageIndex: 0, tokens: 1_500 }),
      ),
      2_000,
    );
  });

  it("refuses a downward move until three consecutive samples corroborate it", () => {
    const calibration = new ContextEstimateCalibration();
    const projection = projected({
      usageTokens: 1_000,
      trailingTokens: 100,
      lastUsageIndex: 0,
      tokens: 5_000,
    });

    assert.equal(calibration.correct(projection), 5_000);

    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 1_000, 1_500);
    }

    const corrected = calibration.correct(projection);
    assert.isBelow(corrected, 5_000);
    assert.isAtLeast(corrected, 5_000 * 0.85);
  });

  it("caps one downward step at 15% of the previous correction factor", () => {
    const calibration = new ContextEstimateCalibration();
    const upward = projected({
      usageTokens: 1_000,
      trailingTokens: 1_000,
      lastUsageIndex: 0,
      tokens: 2_000,
    });
    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 1_000, 2_500);
    }
    assert.equal(calibration.correct(upward), 2_500);

    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 1_000, 1_500);
    }
    assert.equal(
      calibration.correct({ ...upward, trailingTokens: 0, tokens: 5_000 }),
      Math.round(5_000 * 1.25 * 0.85),
    );
  });

  it("discards misreports and freezes the downward direction after two of them", () => {
    const calibration = new ContextEstimateCalibration();
    calibration.recordUnanchored(1_000, 10_000);
    calibration.recordUnanchored(1_000, 10_000);

    assert.isTrue(calibration.frozen());
    assert.deepEqual(calibration.band(), { samples: 0, lowRatio: 1, highRatio: 1 });

    calibration.recordUnanchored(1_000, 1_200);
    assert.isFalse(calibration.frozen());
    assert.equal(calibration.band().highRatio, 1.2);
  });

  it("adds at most 32k of unanchored overhead and only at a comparable scale", () => {
    const calibration = new ContextEstimateCalibration();
    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordUnanchored(20_000, 60_000);
    }

    assert.equal(calibration.unanchoredRatio(20_000), 3);
    assert.isNull(calibration.unanchoredRatio(1_000_000));
    assert.equal(calibration.overheadTokens(), 32_000);
    assert.equal(calibration.correct(projected({ tokens: 60_000 })), 92_000);
  });

  it("ignores samples that carry no usable measurement", () => {
    const calibration = new ContextEstimateCalibration();
    calibration.recordAnchored(0, 500, 2_000);
    calibration.recordAnchored(1_000, 0, 2_000);
    calibration.recordAnchored(1_000, 500, 500);
    calibration.recordUnanchored(0, 2_000);
    calibration.recordUnanchored(1_000, 0);

    assert.equal(calibration.trailingRatio(), 1);
    assert.equal(calibration.overheadTokens(), 0);
    assert.equal(calibration.band().samples, 0);
  });

  it("describes itself in a view a caller can log", () => {
    const calibration = new ContextEstimateCalibration();
    for (let sample = 0; sample < 3; sample += 1) {
      calibration.recordAnchored(1_000, 500, 2_000);
    }
    const view = calibration.view(1_500, 2_000);

    assert.equal(view.anchoredSamples, 3);
    assert.equal(view.trailingRatio, 2);
    assert.equal(view.residualLowRatio, 2_000 / 1_500);
    assert.equal(view.rawTokens, 1_500);
    assert.equal(view.correctedTokens, 2_000);
    assert.isFalse(view.frozen);
  });
});
