import FFT from "fft.js";
import { PNG } from "pngjs";

/**
 * Tier 1.4 follow-up: detect a uniform pixel shift between baseline
 * and candidate via FFT phase correlation. Used by the L1 pre-alignment
 * pass when `CheckpointOptions.ignoreDisplacements` is true.
 *
 * Algorithm (standard phase correlation):
 *   1. Decode + downsample both images to grayscale at FFT_SIZE × FFT_SIZE.
 *   2. 2-D FFT both via row-then-column passes (fft.js is 1-D real-input).
 *   3. Cross-power spectrum R = F_c * conj(F_b) / |F_c * conj(F_b)|.
 *   4. Inverse 2-D FFT → correlation surface.
 *   5. Find peak coord; convert to signed shift (peak > size/2 ⇒ negative).
 *   6. Scale shift back to original pixel coords via the downsample factor.
 *   7. Confidence = peak / (mean × FFT_SIZE).
 *
 * Returns null on dimension mismatch or decode failure (caller treats
 * as "no displacement detected", falls through to the normal L1 path).
 */

/** Power-of-2 size that fft.js can transform. 256 keeps the FFT under
 *  ~30 ms on x86 and is more than enough resolution to detect global
 *  shifts at the scale we care about (a 1-pixel error at 256 maps to
 *  ~8 pixels at 1920 — well within the noise floor of phase correlation
 *  on real captures). */
const FFT_SIZE = 256;

/** Below this peak/mean ratio, the detected shift is too noisy to
 *  trust. The engine consults this when deciding to apply the shift. */
export const DISPLACEMENT_CONFIDENCE_THRESHOLD = 0.05;

export interface DisplacementResult {
  dx: number;
  dy: number;
  confidence: number;
}

export function detectGlobalDisplacement(
  baseline: Buffer,
  candidate: Buffer,
): DisplacementResult | null {
  let baselineDecoded: PNG;
  let candidateDecoded: PNG;
  try {
    baselineDecoded = PNG.sync.read(baseline);
    candidateDecoded = PNG.sync.read(candidate);
  } catch {
    return null;
  }
  if (
    baselineDecoded.width !== candidateDecoded.width ||
    baselineDecoded.height !== candidateDecoded.height
  ) {
    return null;
  }
  const width = baselineDecoded.width;
  const height = baselineDecoded.height;
  if (width < FFT_SIZE || height < FFT_SIZE) {
    // Smaller-than-FFT images are rare (we expect 1920×1080+), but
    // the downsample math would underflow. Fall through to "no
    // displacement detected" — the L1 engine still runs unchanged.
    return null;
  }

  const factorX = Math.floor(width / FFT_SIZE);
  const factorY = Math.floor(height / FFT_SIZE);
  const baselineDS = grayscaleAndDownsample(baselineDecoded, factorX, factorY);
  const candidateDS = grayscaleAndDownsample(
    candidateDecoded,
    factorX,
    factorY,
  );

  const surface = phaseCorrelate(baselineDS, candidateDS);
  const peak = findPeak(surface);

  // Convert peak coordinate to signed shift (wrap-around).
  let dx = peak.x > FFT_SIZE / 2 ? peak.x - FFT_SIZE : peak.x;
  let dy = peak.y > FFT_SIZE / 2 ? peak.y - FFT_SIZE : peak.y;
  // Scale back to original pixel coords.
  dx *= factorX;
  dy *= factorY;

  return { dx, dy, confidence: peak.confidence };
}

/** Decode an RGBA PNG into a Float32Array of grayscale luminance values
 *  at FFT_SIZE × FFT_SIZE, by box-averaging each (factorX × factorY)
 *  source block into one downsampled pixel. */
function grayscaleAndDownsample(
  img: PNG,
  factorX: number,
  factorY: number,
): Float32Array {
  const out = new Float32Array(FFT_SIZE * FFT_SIZE);
  // img.data is a Buffer (Uint8Array); noUncheckedIndexedAccess does not
  // apply to typed-array accesses via a locally-computed index we know is
  // in-range, but TypeScript still widens the type.  The casts below are
  // safe because every index is within the allocated buffer.
  const px = img.data as unknown as { [k: number]: number };
  for (let dy = 0; dy < FFT_SIZE; dy++) {
    for (let dx = 0; dx < FFT_SIZE; dx++) {
      let sum = 0;
      const sx0 = dx * factorX;
      const sy0 = dy * factorY;
      const n = factorX * factorY;
      for (let by = 0; by < factorY; by++) {
        for (let bx = 0; bx < factorX; bx++) {
          const idx = ((sy0 + by) * img.width + (sx0 + bx)) * 4;
          // Luminance: simple average of R, G, B.
          sum += ((px[idx] ?? 0) + (px[idx + 1] ?? 0) + (px[idx + 2] ?? 0)) / 3;
        }
      }
      out[dy * FFT_SIZE + dx] = sum / n;
    }
  }
  return out;
}

/** Compute the phase-correlation surface for two real-valued
 *  FFT_SIZE × FFT_SIZE inputs. Returns the inverse-FFT magnitude
 *  surface (real, FFT_SIZE × FFT_SIZE). */
function phaseCorrelate(a: Float32Array, b: Float32Array): Float32Array {
  // fft.js is 1-D. We do row-then-column passes:
  //   - Row pass uses realTransform (real input → 2N-length complex).
  //   - Column pass uses transform (already-complex input).
  const fft = new FFT(FFT_SIZE);

  // 2*N*N floats — interleaved real/imag per cell, row-major.
  const A = new Float64Array(2 * FFT_SIZE * FFT_SIZE);
  const B = new Float64Array(2 * FFT_SIZE * FFT_SIZE);

  // Reusable 1-D buffers.
  const rowIn = new Float64Array(FFT_SIZE);
  const cmplxOut = new Float64Array(2 * FFT_SIZE);
  const colIn = new Float64Array(2 * FFT_SIZE);
  const colOut = new Float64Array(2 * FFT_SIZE);

  // --- Row pass on A (real input) ---
  for (let y = 0; y < FFT_SIZE; y++) {
    for (let x = 0; x < FFT_SIZE; x++) rowIn[x] = a[y * FFT_SIZE + x] ?? 0;
    fft.realTransform(cmplxOut, rowIn);
    fft.completeSpectrum(cmplxOut);
    for (let x = 0; x < FFT_SIZE; x++) {
      A[(y * FFT_SIZE + x) * 2] = cmplxOut[x * 2] ?? 0;
      A[(y * FFT_SIZE + x) * 2 + 1] = cmplxOut[x * 2 + 1] ?? 0;
    }
  }
  // --- Row pass on B (real input) ---
  for (let y = 0; y < FFT_SIZE; y++) {
    for (let x = 0; x < FFT_SIZE; x++) rowIn[x] = b[y * FFT_SIZE + x] ?? 0;
    fft.realTransform(cmplxOut, rowIn);
    fft.completeSpectrum(cmplxOut);
    for (let x = 0; x < FFT_SIZE; x++) {
      B[(y * FFT_SIZE + x) * 2] = cmplxOut[x * 2] ?? 0;
      B[(y * FFT_SIZE + x) * 2 + 1] = cmplxOut[x * 2 + 1] ?? 0;
    }
  }

  // --- Column pass on A and B (complex input via transform()) ---
  for (let x = 0; x < FFT_SIZE; x++) {
    for (let y = 0; y < FFT_SIZE; y++) {
      colIn[y * 2] = A[(y * FFT_SIZE + x) * 2] ?? 0;
      colIn[y * 2 + 1] = A[(y * FFT_SIZE + x) * 2 + 1] ?? 0;
    }
    fft.transform(colOut, colIn);
    for (let y = 0; y < FFT_SIZE; y++) {
      A[(y * FFT_SIZE + x) * 2] = colOut[y * 2] ?? 0;
      A[(y * FFT_SIZE + x) * 2 + 1] = colOut[y * 2 + 1] ?? 0;
    }

    for (let y = 0; y < FFT_SIZE; y++) {
      colIn[y * 2] = B[(y * FFT_SIZE + x) * 2] ?? 0;
      colIn[y * 2 + 1] = B[(y * FFT_SIZE + x) * 2 + 1] ?? 0;
    }
    fft.transform(colOut, colIn);
    for (let y = 0; y < FFT_SIZE; y++) {
      B[(y * FFT_SIZE + x) * 2] = colOut[y * 2] ?? 0;
      B[(y * FFT_SIZE + x) * 2 + 1] = colOut[y * 2 + 1] ?? 0;
    }
  }

  // --- Cross-power spectrum: R = B * conj(A) / |B * conj(A)| ---
  // Using B * conj(A) (candidate × conj(baseline)) so the resulting
  // peak location gives a positive shift when the candidate content
  // has moved in the positive direction relative to the baseline.
  const R = new Float64Array(2 * FFT_SIZE * FFT_SIZE);
  for (let i = 0; i < FFT_SIZE * FFT_SIZE; i++) {
    const ar = A[i * 2] ?? 0;
    const ai = A[i * 2 + 1] ?? 0;
    const br = B[i * 2] ?? 0;
    const bi = B[i * 2 + 1] ?? 0;
    // B * conj(A) = (br + bi*j) * (ar - ai*j)
    //             = (br*ar + bi*ai) + (bi*ar - br*ai)*j
    const cr = br * ar + bi * ai;
    const ci = bi * ar - br * ai;
    const mag = Math.sqrt(cr * cr + ci * ci);
    if (mag < 1e-12) {
      R[i * 2] = 0;
      R[i * 2 + 1] = 0;
    } else {
      R[i * 2] = cr / mag;
      R[i * 2 + 1] = ci / mag;
    }
  }

  // --- Inverse 2-D FFT: column pass then row pass ---
  for (let x = 0; x < FFT_SIZE; x++) {
    for (let y = 0; y < FFT_SIZE; y++) {
      colIn[y * 2] = R[(y * FFT_SIZE + x) * 2] ?? 0;
      colIn[y * 2 + 1] = R[(y * FFT_SIZE + x) * 2 + 1] ?? 0;
    }
    fft.inverseTransform(colOut, colIn);
    for (let y = 0; y < FFT_SIZE; y++) {
      R[(y * FFT_SIZE + x) * 2] = colOut[y * 2] ?? 0;
      R[(y * FFT_SIZE + x) * 2 + 1] = colOut[y * 2 + 1] ?? 0;
    }
  }
  for (let y = 0; y < FFT_SIZE; y++) {
    for (let x = 0; x < FFT_SIZE; x++) {
      colIn[x * 2] = R[(y * FFT_SIZE + x) * 2] ?? 0;
      colIn[x * 2 + 1] = R[(y * FFT_SIZE + x) * 2 + 1] ?? 0;
    }
    fft.inverseTransform(colOut, colIn);
    for (let x = 0; x < FFT_SIZE; x++) {
      R[(y * FFT_SIZE + x) * 2] = colOut[x * 2] ?? 0;
      R[(y * FFT_SIZE + x) * 2 + 1] = colOut[x * 2 + 1] ?? 0;
    }
  }

  // --- Magnitude of the correlation surface ---
  const mag = new Float32Array(FFT_SIZE * FFT_SIZE);
  for (let i = 0; i < FFT_SIZE * FFT_SIZE; i++) {
    const re = R[i * 2] ?? 0;
    const im = R[i * 2 + 1] ?? 0;
    mag[i] = Math.sqrt(re * re + im * im);
  }
  return mag;
}

/** Find the brightest cell in a FFT_SIZE × FFT_SIZE surface, returning
 *  its coordinates + confidence (peak / (mean × FFT_SIZE)). */
function findPeak(surface: Float32Array): {
  x: number;
  y: number;
  confidence: number;
} {
  let peakVal = -Infinity;
  let peakIdx = 0;
  let sum = 0;
  for (let i = 0; i < surface.length; i++) {
    const v = surface[i] ?? 0;
    sum += v;
    if (v > peakVal) {
      peakVal = v;
      peakIdx = i;
    }
  }
  const mean = sum / surface.length;
  // Normalise by FFT_SIZE so the scale is independent of the transform
  // size: a perfect impulse (identical images) gives confidence ≈ FFT_SIZE,
  // a good structural shift gives ~2–3, and uncorrelated noise gives <0.05.
  const confidence = mean > 0 ? peakVal / (mean * FFT_SIZE) : 0;
  return {
    x: peakIdx % FFT_SIZE,
    y: Math.floor(peakIdx / FFT_SIZE),
    confidence,
  };
}
