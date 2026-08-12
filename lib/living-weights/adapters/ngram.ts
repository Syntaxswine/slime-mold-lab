/**
 * Living Weights — an offline language model with readable logits.
 *
 * This exists because the Anthropic Messages API exposes no logprobs and no
 * temperature on the current frontier models, so it cannot serve the top-N
 * candidates-with-scores the piece is built on (docs/HANDOFF.md section 7).
 * The real path is a local open-weights model behind `local-http.ts`. This
 * adapter is what makes Phase 1 runnable, testable and bit-reproducible
 * without a multi-gigabyte download: a stupid-backoff n-gram model whose
 * logits are genuine log-probabilities of a genuine (if very small) model.
 *
 * Do not mistake it for the artistic target. It is the bench supply.
 */
import type { Candidate, LanguageModelAdapter } from "../types.ts";

/** Backoff discount per dropped order, following Brants et al. 2007. */
const BACKOFF = 0.4;

const WORD = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*|[.,;:!?—]/g;
const PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "—"]);

export function tokenize(text: string): string[] {
  return text.match(WORD) ?? [];
}

export type NgramConfig = {
  /** Label for the log, so a run names the corpus it came from. */
  corpusId: string;
  order: number;
};

export function makeNgramAdapter(
  corpus: string,
  overrides: Partial<NgramConfig> = {},
): LanguageModelAdapter {
  const config: NgramConfig = { corpusId: "inline", order: 3, ...overrides };
  const counts: Map<string, Map<string, number>>[] = [];
  const totals: Map<string, number>[] = [];
  for (let k = 0; k < config.order; k += 1) {
    counts.push(new Map());
    totals.push(new Map());
  }

  // Sentence boundaries are real context: a corpus of one-line observations
  // has almost no cross-sentence bigrams worth trusting.
  for (const line of corpus.split(/\n+/)) {
    const words = tokenize(line);
    if (words.length === 0) continue;
    const padded = ["<s>", "<s>", ...words, "</s>"];
    for (let k = 0; k < config.order; k += 1) {
      for (let i = k; i < padded.length - 1; i += 1) {
        const context = padded.slice(i - k, i + 1).join(" ");
        const next = padded[i + 1];
        let bucket = counts[k].get(context);
        if (!bucket) {
          bucket = new Map();
          counts[k].set(context, bucket);
        }
        bucket.set(next, (bucket.get(next) ?? 0) + 1);
        totals[k].set(context, (totals[k].get(context) ?? 0) + 1);
      }
    }
  }

  const vocabulary = new Map<string, number>();
  for (const [, bucket] of counts[0]) {
    for (const [token, n] of bucket) vocabulary.set(token, (vocabulary.get(token) ?? 0) + n);
  }
  const vocabularyTotal = [...vocabulary.values()].reduce((a, b) => a + b, 0);

  return {
    id: "ngram-stupid-backoff",
    config: { ...config, vocabulary: vocabulary.size, corpusChars: corpus.length },

    async candidates(text: string, count: number): Promise<Candidate[]> {
      // Context is the current line, not the whole transcript. `append` ends a
      // sentence with a newline, so this is what restarts the model cleanly at
      // a sentence boundary instead of conditioning on the previous full stop.
      const line = text.split("\n").pop() ?? "";
      const history = ["<s>", "<s>", ...tokenize(line)];
      const scores = new Map<string, number>();

      /**
       * Every order contributes, not only the longest one that matched. A
       * trigram context in a corpus this size is usually unique, so taking
       * only the highest available order would replay the corpus verbatim and
       * leave the organism nothing to choose between. Mixing the discounted
       * lower orders in guarantees real competition at every step, which is
       * the property the whole piece depends on.
       */
      for (let k = config.order - 1; k >= 0; k -= 1) {
        const context = history.slice(history.length - 1 - k).join(" ");
        const bucket = counts[k].get(context);
        if (!bucket) continue;
        const total = totals[k].get(context) ?? 1;
        const discount = BACKOFF ** (config.order - 1 - k);
        for (const [token, n] of bucket) {
          const score = (n / total) * discount;
          if (score > (scores.get(token) ?? 0)) scores.set(token, score);
        }
      }

      // Unigram floor. Without it a dead context returns nothing and the run
      // stops silently instead of saying something dull.
      if (scores.size < count) {
        const discount = BACKOFF ** config.order;
        for (const [token, n] of vocabulary) {
          const score = (n / vocabularyTotal) * discount;
          if (score > (scores.get(token) ?? 0)) scores.set(token, score);
        }
      }

      // `<s>` is a real successor in the counts -- the padding means the second
      // start marker follows the first -- but it is scaffolding, not a word. At
      // low gain the model's own ranking buries it; at gain 5 and up the
      // organism promotes it and the text degenerates into a row of markers.
      scores.delete("<s>");

      // Ties broken lexicographically so the ordering is a pure function of
      // the corpus. Anything else makes replay a lie.
      return [...scores]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, count)
        .map(([token, score]): Candidate => ({ token, logit: Math.log(score) }));
    },

    append(text: string, token: string): string {
      if (token === "</s>") return `${text}\n`;
      if (text.length === 0) return token;
      if (PUNCTUATION.has(token)) return text + token;
      if (text.endsWith("\n")) return text + token;
      return `${text} ${token}`;
    },
  };
}
