/**
 * Measured accuracy of the context estimate, kept as two separate series: the
 * per-character bias of a projection anchored on a real usage block, and the
 * residual of a projection that has no anchor (which also carries the missing
 * system/tool overhead). Safety properties live with their constants below.
 */

/** Observations needed before a series is trusted; below this the raw value stands. */
const CONTEXT_CALIBRATION_MIN_SAMPLES = 3;

/** Bounded window per series: the median of these, so one outlier cannot move it. */
const CONTEXT_CALIBRATION_WINDOW = 16;

/** Per-character bias may not be calibrated outside this range. Scale-free. */
const CONTEXT_CALIBRATION_RATIO_MIN = 0.75;
const CONTEXT_CALIBRATION_RATIO_MAX = 4;

/**
 * The corrected value may not leave this band around the raw estimate. The lower
 * bound is the dangerous direction — a number that reads low postpones compaction
 * — so it is a hard floor no combination of samples can pass; the upper bound
 * stays generous, because an unanchored projection can miss a whole system prompt.
 */
const CONTEXT_CALIBRATION_FACTOR_MIN = 0.85;
const CONTEXT_CALIBRATION_FACTOR_MAX = 6;

/**
 * A provider report outside this band around what the calibration predicted is a
 * misreport (a cached call, a summary request, a gateway substituting a number):
 * discarded rather than folded in.
 */
const CONTEXT_CALIBRATION_SAMPLE_MIN_RATIO = 0.5;
const CONTEXT_CALIBRATION_SAMPLE_MAX_RATIO = 3;

/** Consecutive misreports that freeze the downward direction. */
const CONTEXT_CALIBRATION_ANOMALY_FREEZE = 2;

/** Agreeing samples required before the corrected value may move down at all. */
const CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE = 3;

/** Most one downward step may take off the raw estimate. */
const CONTEXT_CALIBRATION_DOWNWARD_STEP_MAX = 0.15;

/** How far a sample's scale may sit from the estimate before it stops being a ratio. */
const CONTEXT_CALIBRATION_SCALE_BAND_MIN = 0.5;
const CONTEXT_CALIBRATION_SCALE_BAND_MAX = 2;

/** The fixed part of an unanchored residual may not exceed this many tokens. */
const CONTEXT_CALIBRATION_OVERHEAD_CAP = 32_000;

/** A report this many times the request is a misreport, never a measurement. */
const CONTEXT_CALIBRATION_REAL_MAX_RATIO = 20;

/** The displayed band ignores residuals outside this range. */
const CONTEXT_CALIBRATION_RESIDUAL_MIN = 0.25;
const CONTEXT_CALIBRATION_RESIDUAL_MAX = 4;

/** A sample counts as agreeing with a downward move when it reads this much high. */
const CONTEXT_CALIBRATION_DOWNWARD_EVIDENCE = 0.02;

export type ContextCalibration = {
  /** Real tokens the estimator anchors on (the last assistant usage block). */
  readonly usageTokens: number;
  /** Estimated tokens for the messages after that anchor. */
  readonly trailingTokens: number;
  /** Index of the anchor, or null when the projection carries no usage at all. */
  readonly lastUsageIndex: number | null;
  /** The projection's own total: anchor + trailing, raised to the request floor. */
  readonly tokens: number;
};

export type CalibrationView = {
  readonly anchoredSamples: number;
  readonly trailingRatio: number;
  readonly unanchoredSamples: number;
  /** Samples whose scale allowed the ratio form to be used. */
  readonly unanchoredScaleSamples: number;
  readonly unanchoredRatio: number;
  readonly overheadTokens: number;
  readonly residualSamples: number;
  readonly residualLowRatio: number;
  readonly residualHighRatio: number;
  /** Consecutive misreports currently seen. */
  readonly anomalies: number;
  /** True while misreports keep the downward direction frozen. */
  readonly frozen: boolean;
  /** Consecutive samples that said the estimate reads high. */
  readonly downwardStreak: number;
  readonly rawTokens: number;
  readonly correctedTokens: number;
};

/**
 * How far the corrected number has actually been from what the provider
 * reported, as `real / predicted`. `lowRatio` below 1 means the estimate read
 * low — the dangerous direction — as recently as the window shows.
 */
export type ContextCalibrationBand = {
  readonly samples: number;
  readonly lowRatio: number;
  readonly highRatio: number;
};

/** Median of a window; the window is never empty when this is called. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function usableNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type UnanchoredSample = { readonly estimate: number; readonly realTotal: number };

/**
 * Two rolling series, one per error above. Kept apart on purpose: a compacted
 * session has both, and mixing them would apply the system overhead twice on an
 * anchored projection.
 */
export class ContextEstimateCalibration {
  readonly #trailingRatios: number[] = [];
  readonly #unanchored: UnanchoredSample[] = [];
  /** `real / predicted` per usable observation; the displayed band. */
  readonly #residuals: number[] = [];
  #anomalies = 0;
  #downwardStreak = 0;
  /** The last value `correct()` returned, for the per-step cap. */
  #lastCorrected: number | null = null;
  /** Raw scale paired with `#lastCorrected`, so the step cap stays scale-free. */
  #lastRawTokens: number | null = null;

  /**
   * Record one request whose estimate was anchored on a known usage block.
   * `realTotal − usageTokens` is the true size of the messages after the anchor.
   */
  recordAnchored(usageTokens: number, estimatedTrailing: number, realTotal: number): void {
    if (!usableNumber(realTotal) || !usableNumber(usageTokens)) return;
    if (realTotal > usageTokens * CONTEXT_CALIBRATION_REAL_MAX_RATIO) return;
    const trueTrailing = realTotal - usageTokens;
    // Nothing after the anchor carries no information about the per-character
    // bias; a negative difference means the anchor over-counted, which is not
    // this series' error to absorb.
    if (!usableNumber(trueTrailing) || !usableNumber(estimatedTrailing)) return;
    const predicted = usageTokens + estimatedTrailing * this.trailingRatio();
    if (!this.recordResidual(predicted, realTotal)) return;
    this.recordDownwardEvidence(predicted, realTotal);
    this.push(
      this.#trailingRatios,
      clamp(
        trueTrailing / estimatedTrailing,
        CONTEXT_CALIBRATION_RATIO_MIN,
        CONTEXT_CALIBRATION_RATIO_MAX,
      ),
    );
  }

  /**
   * Record one request with no anchor: the estimate covers every message, so the
   * measurement carries the missing system/tool overhead.
   */
  recordUnanchored(estimate: number, realTotal: number): void {
    if (!usableNumber(estimate) || !usableNumber(realTotal)) return;
    if (realTotal > estimate * CONTEXT_CALIBRATION_REAL_MAX_RATIO) return;
    const predicted = this.correctUnanchored(estimate);
    if (!this.recordResidual(predicted, realTotal)) return;
    this.recordDownwardEvidence(predicted, realTotal);
    this.push(this.#unanchored, { estimate, realTotal });
  }

  /**
   * Correct one raw projection. Returns the raw value until its series has enough
   * observations, so a fresh session behaves exactly as it did before.
   */
  correct(raw: ContextCalibration): number {
    const rawTokens = Math.max(0, Math.round(raw.tokens));
    const anchored = raw.lastUsageIndex !== null && usableNumber(raw.usageTokens);
    const corrected = anchored ? this.anchoredCorrection(raw) : this.correctUnanchored(rawTokens);
    const value = this.clampCorrection(corrected, rawTokens);
    this.#lastCorrected = value;
    this.#lastRawTokens = rawTokens;
    return value;
  }

  /** The per-character bias currently believed, or 1 before there is evidence. */
  trailingRatio(): number {
    if (this.#trailingRatios.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return 1;
    return median(this.#trailingRatios);
  }

  /**
   * The residual ratio currently believed at the estimate's own scale, or `null`
   * when no sample was taken at a comparable scale. Scale-free by construction.
   */
  unanchoredRatio(atTokens: number): number | null {
    const inBand = this.inBandSamples(atTokens);
    if (inBand.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return null;
    return median(inBand.map((sample) => sample.realTotal / sample.estimate));
  }

  /**
   * The fixed part of the residual — the system/tool overhead an unanchored
   * projection is missing — capped so it stays an overhead, or 0 before there is
   * evidence.
   */
  overheadTokens(): number {
    if (this.#unanchored.length < CONTEXT_CALIBRATION_MIN_SAMPLES) return 0;
    const overheads = this.#unanchored.map((sample) =>
      Math.max(0, sample.realTotal - sample.estimate),
    );
    return Math.min(CONTEXT_CALIBRATION_OVERHEAD_CAP, median(overheads));
  }

  /** What the last `correct()` did, for logging and for diagnostics. */
  view(rawTokens: number, correctedTokens: number): CalibrationView {
    const band = this.band();
    return {
      anchoredSamples: this.#trailingRatios.length,
      trailingRatio: this.trailingRatio(),
      unanchoredSamples: this.#unanchored.length,
      unanchoredScaleSamples: this.inBandSamples(rawTokens).length,
      unanchoredRatio: this.unanchoredRatio(rawTokens) ?? 0,
      overheadTokens: this.overheadTokens(),
      residualSamples: band.samples,
      residualLowRatio: band.lowRatio,
      residualHighRatio: band.highRatio,
      anomalies: this.#anomalies,
      frozen: this.frozen(),
      downwardStreak: this.#downwardStreak,
      rawTokens,
      correctedTokens,
    };
  }

  /** The spread of real residuals, which is the band the estimate may be shown with. */
  band(): ContextCalibrationBand {
    const samples = this.#residuals.length;
    if (samples === 0) return { samples: 0, lowRatio: 1, highRatio: 1 };
    return {
      samples,
      lowRatio: Math.min(...this.#residuals),
      highRatio: Math.max(...this.#residuals),
    };
  }

  /** True while consecutive misreports keep the downward direction frozen. */
  frozen(): boolean {
    return this.#anomalies >= CONTEXT_CALIBRATION_ANOMALY_FREEZE;
  }

  /**
   * The anchored part is the provider's own number for the prefix and already
   * contains that request's system/tool overhead, so only the guessed tail is
   * scaled: the unanchored residual must not be added here.
   */
  private anchoredCorrection(raw: ContextCalibration): number {
    return raw.usageTokens + Math.max(0, raw.trailingTokens) * this.trailingRatio();
  }

  /** An unanchored correction: ratio in band, fixed overhead otherwise. */
  private correctUnanchored(rawTokens: number): number {
    if (rawTokens <= 0) return Math.max(0, rawTokens);
    const ratio = this.unanchoredRatio(rawTokens);
    if (ratio !== null) return rawTokens * ratio;
    const overhead = this.overheadTokens();
    return overhead > 0 ? rawTokens + overhead : rawTokens;
  }

  /** Samples taken at a scale comparable to `atTokens`. */
  private inBandSamples(atTokens: number): UnanchoredSample[] {
    if (!usableNumber(atTokens)) return [];
    return this.#unanchored.filter(
      (sample) =>
        sample.estimate >= atTokens * CONTEXT_CALIBRATION_SCALE_BAND_MIN &&
        sample.estimate <= atTokens * CONTEXT_CALIBRATION_SCALE_BAND_MAX,
    );
  }

  private recordResidual(predicted: number, realTotal: number): boolean {
    if (!usableNumber(predicted) || !usableNumber(realTotal)) return false;
    const ratio = realTotal / predicted;
    if (!Number.isFinite(ratio)) return false;
    // Anomalies never move the value up either: an unusable report is not
    // evidence in either direction, and freezing covers the downward one.
    if (
      ratio < CONTEXT_CALIBRATION_SAMPLE_MIN_RATIO ||
      ratio > CONTEXT_CALIBRATION_SAMPLE_MAX_RATIO
    ) {
      this.#anomalies += 1;
      return false;
    }
    this.#anomalies = 0;
    if (ratio < CONTEXT_CALIBRATION_RESIDUAL_MIN || ratio > CONTEXT_CALIBRATION_RESIDUAL_MAX) {
      return false;
    }
    this.push(this.#residuals, ratio);
    return true;
  }

  /** Does this sample say the estimate reads high enough to justify a step down? */
  private recordDownwardEvidence(predicted: number, realTotal: number): void {
    if (!usableNumber(predicted) || !usableNumber(realTotal)) return;
    if (realTotal < predicted * (1 - CONTEXT_CALIBRATION_DOWNWARD_EVIDENCE)) {
      this.#downwardStreak += 1;
      return;
    }
    this.#downwardStreak = 0;
  }

  private push<T>(series: T[], value: T): void {
    series.push(value);
    if (series.length > CONTEXT_CALIBRATION_WINDOW) series.shift();
  }

  private clampCorrection(corrected: number, rawTokens: number): number {
    if (!Number.isFinite(corrected)) return rawTokens;
    // A raw estimate of zero carries no scale to clamp against.
    if (rawTokens <= 0) return Math.max(0, Math.round(corrected));
    const value = clamp(
      corrected,
      rawTokens * CONTEXT_CALIBRATION_FACTOR_MIN,
      rawTokens * CONTEXT_CALIBRATION_FACTOR_MAX,
    );
    if (value >= rawTokens) return Math.round(value);
    // Keep the step cap in normalized factor space: compaction can make the next
    // raw estimate much smaller than the previous request.
    if (!this.downwardAllowed()) return rawTokens;
    const previousFactor =
      this.#lastCorrected !== null && this.#lastRawTokens !== null && this.#lastRawTokens > 0
        ? this.#lastCorrected / this.#lastRawTokens
        : null;
    const stepFloor =
      previousFactor === null
        ? value
        : rawTokens *
          Math.min(
            CONTEXT_CALIBRATION_FACTOR_MAX,
            previousFactor * (1 - CONTEXT_CALIBRATION_DOWNWARD_STEP_MAX),
          );
    return Math.round(Math.max(value, stepFloor));
  }

  private downwardAllowed(): boolean {
    return !this.frozen() && this.#downwardStreak >= CONTEXT_CALIBRATION_DOWNWARD_CONSECUTIVE;
  }
}
