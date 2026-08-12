/**
 * Living Weights — replay and verification.
 *
 * Two different claims, checked separately, because they fail for different
 * reasons and a single green tick would hide that:
 *
 *   `verifyRun`  — every logged decision follows from its own logged inputs.
 *                  Catches drift between the weighting code and the archive:
 *                  a log written last year must still recompute today, or the
 *                  provenance is decoration.
 *
 *   `rerun`      — the same seed and the same controls reproduce the run from
 *                  nothing. Catches hidden state: an unseeded draw, a provider
 *                  that remembers, a Date.now() in the path.
 *
 * A run can pass the first and fail the second. That is precisely the bug
 * worth finding, so neither check subsumes the other.
 */
import type { ParsedRun } from "./log.ts";
import type { LanguageModelAdapter, Signal, StepRecord } from "./types.ts";
import { combine, normalizeSignals, select } from "./weights.ts";
import { LivingWeightsRun, type RunOptions } from "./generator.ts";

export type Discrepancy = {
  step: number;
  field: string;
  logged: string;
  recomputed: string;
};

export type VerifyReport = {
  steps: number;
  discrepancies: Discrepancy[];
  ok: boolean;
};

/**
 * Rebuild the channel readings the generator saw, from the candidate records.
 *
 * Sound because the generator reads exactly `min(candidateCount, channelCount)`
 * channels and every one of them is carried on at least one candidate: with
 * fewer candidates than channels the assignment is injective, and with more it
 * is `i % channelCount`, which covers all of them.
 */
function signalsFrom(record: StepRecord): Signal[] {
  const byChannel = new Map<number, Signal>();
  for (const c of record.candidates) {
    if (!byChannel.has(c.channel)) {
      byChannel.set(c.channel, {
        channel: c.channel,
        value: 0,
        raw: c.raw,
        timestamp: record.providerClock,
        quality: c.quality,
      });
    }
  }
  return [...byChannel.values()].sort((a, b) => a.channel - b.channel);
}

export function verifyRun(parsed: ParsedRun, tolerance = 1e-9): VerifyReport {
  const discrepancies: Discrepancy[] = [];

  for (const record of parsed.records) {
    const signals = signalsFrom(record);
    const normalized = normalizeSignals(signals, parsed.header.normalize);
    const logits = record.candidates.map((c) => c.lmLogit);
    const score = record.candidates.map((c) => normalized.score[c.channel] ?? 0);
    const combined = combine(
      logits,
      score,
      record.controls.gain,
      normalized.confidence,
      record.controls.temperature,
    );

    const check = (field: string, logged: number, got: number) => {
      if (Math.abs(logged - got) > tolerance) {
        discrepancies.push({
          step: record.step,
          field,
          logged: logged.toPrecision(12),
          recomputed: got.toPrecision(12),
        });
      }
    };

    check("confidence", record.confidence, normalized.confidence);
    check("spread", record.spread, normalized.spread);
    check("effectiveGain", record.effectiveGain, combined.effectiveGain);
    for (let i = 0; i < record.candidates.length; i += 1) {
      check(`candidates[${i}].score`, record.candidates[i].score, score[i]);
      check(`candidates[${i}].adjustedProb`, record.candidates[i].adjustedProb, combined.adjustedProb[i]);
    }

    const picked = select(
      record.controls.mode,
      combined.adjustedProb,
      record.uniform ?? 0,
      record.controls.separation,
    );
    if (picked.index !== record.chosenIndex) {
      discrepancies.push({
        step: record.step,
        field: "chosenIndex",
        logged: String(record.chosenIndex),
        recomputed: String(picked.index),
      });
    }
  }

  return { steps: parsed.records.length, discrepancies, ok: discrepancies.length === 0 };
}

/** Verify the text chain: each step's `textBefore` follows from the last decision. */
export function verifyChain(parsed: ParsedRun, adapter: LanguageModelAdapter): Discrepancy[] {
  const out: Discrepancy[] = [];
  for (let i = 1; i < parsed.records.length; i += 1) {
    const previous = parsed.records[i - 1];
    const expected = adapter.append(previous.textBefore, previous.chosenToken);
    if (expected !== parsed.records[i].textBefore) {
      out.push({
        step: parsed.records[i].step,
        field: "textBefore",
        logged: JSON.stringify(parsed.records[i].textBefore.slice(-40)),
        recomputed: JSON.stringify(expected.slice(-40)),
      });
    }
  }
  return out;
}

/**
 * Re-run from the header alone and compare token for token.
 *
 * Controls come from the header, so a run whose controls were moved live
 * cannot be reproduced this way — by design. That is a true statement about
 * the artefact, not a limitation to paper over: if the operator turned the
 * gain up mid-sentence, the sentence is not a function of the seed.
 */
export async function rerun(
  parsed: ParsedRun,
  build: () => Pick<RunOptions, "adapter" | "provider">,
): Promise<{ matched: number; total: number; firstMismatch: number | null; text: string }> {
  const { adapter, provider } = build();
  provider.reset();
  const run = new LivingWeightsRun({
    adapter,
    provider,
    prompt: parsed.header.prompt,
    seed: parsed.header.seed,
    controls: parsed.header.controls,
    normalize: parsed.header.normalize,
    now: () => 0,
  });
  await run.run(parsed.records.length);

  let matched = 0;
  let firstMismatch: number | null = null;
  for (let i = 0; i < parsed.records.length; i += 1) {
    const a = parsed.records[i]?.chosenToken;
    const b = run.records[i]?.chosenToken;
    if (a === b) matched += 1;
    else if (firstMismatch === null) firstMismatch = i;
  }
  return { matched, total: parsed.records.length, firstMismatch, text: run.text };
}
