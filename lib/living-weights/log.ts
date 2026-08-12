/**
 * Living Weights — run logs.
 *
 * JSONL: one header line, then one line per decision. Line-oriented so a long
 * installation run can be appended to and tailed without holding it in memory,
 * and so a truncated file is still readable up to the last complete decision.
 *
 * The log is the artwork's evidence. It is what lets you point at a sentence
 * and say exactly where the organism bent it, which is the only thing that
 * separates this from a text generator with an interesting story attached.
 */
import type { RunHeader, StepRecord } from "./types.ts";

export type ParsedRun = {
  header: RunHeader;
  records: StepRecord[];
};

export function serializeRun(header: RunHeader, records: StepRecord[]): string {
  const lines = [JSON.stringify(header), ...records.map((r) => JSON.stringify(r))];
  return `${lines.join("\n")}\n`;
}

export function parseRun(text: string): ParsedRun {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("empty run log");
  const header = JSON.parse(lines[0]) as RunHeader;
  if (header.format !== "living-weights/1") {
    throw new Error(`unknown log format: ${String(header.format)}`);
  }
  const records: StepRecord[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    records.push(JSON.parse(lines[i]) as StepRecord);
  }
  return { header, records };
}

/** Text as it stood after the last logged decision. */
export function textOf(parsed: ParsedRun, append: (text: string, token: string) => string): string {
  const last = parsed.records[parsed.records.length - 1];
  if (!last) return parsed.header.prompt;
  return append(last.textBefore, last.chosenToken);
}

/** The spec's CSV export, flattened one row per candidate per step. */
export function toCsv(parsed: ParsedRun): string {
  const header = [
    "step", "token", "chosen", "baseline", "channel", "lm_logit", "lm_prob",
    "raw", "quality", "score", "adjusted_logit", "adjusted_prob",
    "gain", "effective_gain", "confidence", "spread", "temperature", "mode",
    "assignment", "attempts", "provider_clock",
  ].join(",");
  const rows = [header];
  for (const record of parsed.records) {
    for (let i = 0; i < record.candidates.length; i += 1) {
      const c = record.candidates[i];
      rows.push([
        record.step,
        JSON.stringify(c.token),
        i === record.chosenIndex ? 1 : 0,
        i === record.baselineIndex ? 1 : 0,
        c.channel,
        c.lmLogit.toFixed(6),
        c.lmProb.toFixed(6),
        c.raw.toFixed(6),
        c.quality.toFixed(6),
        c.score.toFixed(6),
        c.adjustedLogit.toFixed(6),
        c.adjustedProb.toFixed(6),
        record.controls.gain,
        record.effectiveGain.toFixed(6),
        record.confidence.toFixed(6),
        record.spread.toFixed(6),
        record.controls.temperature,
        record.controls.mode,
        record.controls.assignment,
        record.attempts,
        record.providerClock,
      ].join(","));
    }
  }
  return `${rows.join("\n")}\n`;
}
