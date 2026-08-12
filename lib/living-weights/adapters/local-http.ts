/**
 * Living Weights — candidates and logits from a local open-weights model.
 *
 * This is the intended production path, and the reason it is not the default
 * is documented rather than convenient: the Anthropic Messages API exposes no
 * logprobs, and temperature / top_p / top_k are removed on the current
 * frontier Claude models, so no hosted Claude endpoint can serve the top-N
 * candidates-with-scores this piece is built on. Anything where the logit
 * tensor is readable before sampling will do — llama.cpp's server, an
 * OpenAI-compatible shim in front of vLLM, an MLX or transformers wrapper.
 *
 * NOT EXERCISED BY THE TEST SUITE. There is no model in this repo to talk to,
 * so what is tested is the request built and the response parsed, against
 * recorded fixtures. Treat the first live run as the real integration test and
 * check the two invariants below before believing anything it produces.
 *
 * Invariant 1 — the server must return the model's own distribution.
 * Ask for temperature 1 and no truncation. If the server applies its own
 * top_p, repetition penalty or mirostat first, then "gain 0 reproduces the
 * language model" is only true of whatever the server already reshaped, and
 * the provenance in the log quietly means something weaker than it claims.
 *
 * Invariant 2 — the server must be deterministic across runs.
 * Batched or GPU-nondeterministic inference will give slightly different
 * logits for the same prompt, which is enough to reroute a sampled token and
 * break replay. Pin the seed, batch size 1, and verify with
 * `node tools/weights.mjs replay` before an installation run.
 */
import type { Candidate, LanguageModelAdapter } from "../types.ts";

export type LocalHttpConfig = {
  /** Full URL of the completion endpoint. */
  endpoint: string;
  /** `llama.cpp` for /completion, `openai` for /v1/completions. */
  shape: "llama.cpp" | "openai";
  /** Sent as `model` in the openai shape; recorded in the log either way. */
  model: string;
  /** Server-side sampling seed, where the server honours one. */
  seed: number;
  timeoutMs: number;
};

export const DEFAULT_LOCAL_HTTP_CONFIG: LocalHttpConfig = {
  endpoint: "http://127.0.0.1:8080/completion",
  shape: "llama.cpp",
  model: "local",
  seed: 1,
  timeoutMs: 30_000,
};

export function buildRequest(config: LocalHttpConfig, text: string, count: number): unknown {
  if (config.shape === "openai") {
    return {
      model: config.model,
      prompt: text,
      max_tokens: 1,
      // The number of alternatives to score, not a sampling change.
      logprobs: count,
      temperature: 1,
      top_p: 1,
      seed: config.seed,
    };
  }
  return {
    prompt: text,
    n_predict: 1,
    n_probs: count,
    temperature: 1,
    top_p: 1,
    // 0 disables the cutoff in llama.cpp; leaving the default 40 would hand
    // back a pre-truncated distribution and silently cap the candidate list.
    top_k: 0,
    repeat_penalty: 1,
    seed: config.seed,
    cache_prompt: true,
  };
}

/** Exported so the parser can be tested against recorded responses. */
export function parseResponse(
  config: LocalHttpConfig,
  body: unknown,
  count: number,
): Candidate[] {
  const out: Candidate[] = [];
  const data = body as Record<string, unknown>;

  if (config.shape === "openai") {
    const choices = data.choices as { logprobs?: { top_logprobs?: Record<string, number>[] } }[];
    const top = choices?.[0]?.logprobs?.top_logprobs?.[0];
    if (!top) throw new Error("no top_logprobs in response; the server is not scoring alternatives");
    for (const [token, logprob] of Object.entries(top)) out.push({ token, logit: logprob });
  } else {
    const probs = data.completion_probabilities as
      | { probs?: { tok_str?: string; token?: string; prob: number }[] }[]
      | undefined;
    const first = probs?.[0]?.probs;
    if (!first) throw new Error("no completion_probabilities; set n_probs on the server request");
    for (const entry of first) {
      const token = entry.tok_str ?? entry.token ?? "";
      // A zero probability is a real answer from the server, not a missing
      // one. -Infinity is the honest logit and softmax handles it; coercing it
      // to a small number would invent a candidate the model did not offer.
      out.push({ token, logit: entry.prob > 0 ? Math.log(entry.prob) : -Infinity });
    }
  }

  return out
    .sort((a, b) => b.logit - a.logit || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0))
    .slice(0, count);
}

export function makeLocalHttpAdapter(
  overrides: Partial<LocalHttpConfig> = {},
  fetchImpl: typeof fetch = fetch,
): LanguageModelAdapter {
  const config: LocalHttpConfig = { ...DEFAULT_LOCAL_HTTP_CONFIG, ...overrides };

  return {
    id: `local-http:${config.shape}`,
    config: config as unknown as Record<string, unknown>,

    async candidates(text: string, count: number): Promise<Candidate[]> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(config.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildRequest(config, text, count)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`${config.endpoint} returned ${response.status} ${response.statusText}`);
        }
        return parseResponse(config, await response.json(), count);
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Tokens arrive with their own leading whitespace, so they concatenate.
     * Do not "tidy" this into a space-joining version: a subword continuation
     * would gain a space it never had and the text would stop being what the
     * model actually scored.
     */
    append(text: string, token: string): string {
      return text + token;
    },
  };
}
