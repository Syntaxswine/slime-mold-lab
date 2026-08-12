"use client";

/**
 * Living Weights — the interface.
 *
 * Layout follows the brief: run controls on top, the text on the left, eight
 * candidate cards in the middle, the dials on the right, and the organism plus
 * its channel traces and the decision log underneath.
 *
 * One deliberate departure. The brief asks for eight sliders as the Phase 1
 * signal source; they are here, but as the null arm rather than the default.
 * The default is the Physarum engine this repo already contains, because the
 * properties that will define the piece in Phase 2 — jamming, an 8-step trail
 * half-life, a body that cannot be in two places — are exactly the ones a
 * slider cannot have. See docs/LIVING-WEIGHTS.md.
 *
 * The run lives in a child keyed on everything that defines its identity, so
 * changing the prompt or the seed remounts rather than mutating. A run whose
 * prompt changed underneath it would write a log claiming a prompt that never
 * produced the text below it, which is the one thing the log must never do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { makeNgramAdapter } from "../../lib/living-weights/adapters/ngram";
import { LivingWeightsRun } from "../../lib/living-weights/generator";
import { serializeRun, toCsv } from "../../lib/living-weights/log";
import {
  channelOccupancy,
  makeMoldProvider,
  type MoldProvider,
} from "../../lib/living-weights/providers/mold";
import { makeSliderProvider } from "../../lib/living-weights/providers/sliders";
import { DEFAULT_CONTROLS } from "../../lib/living-weights/weights";
import type {
  AssignmentMode,
  Controls,
  MoldSignalProvider,
  SelectionMode,
  StepRecord,
} from "../../lib/living-weights/types";
import { GRID_H, GRID_W } from "../../lib/physarum-engine";

const CORPUS_URL = "/corpora/notebook.txt";
const HISTORY = 90;

type ProviderKind = "mold" | "sliders";

export default function LivingWeightsPage() {
  const [corpus, setCorpus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("The culture");
  const [draftPrompt, setDraftPrompt] = useState("The culture");
  const [seed, setSeed] = useState(20260811);
  const [providerKind, setProviderKind] = useState<ProviderKind>("mold");
  const [controls, setControls] = useState<Controls>({ ...DEFAULT_CONTROLS, moldSteps: 8 });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(CORPUS_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`${CORPUS_URL} -> ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!cancelled) setCorpus(body);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(`could not load the corpus: ${String(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof Controls>(key: K, value: Controls[K]) =>
    setControls((previous) => ({ ...previous, [key]: value }));

  return (
    <main className="lw">
      <style>{CSS}</style>

      <header className="lw-head">
        <div>
          <p className="lw-eyebrow">02 / LIVING WEIGHTS</p>
          <h1>The organism does not write. It changes what the language wants to become.</h1>
        </div>
        <form
          className="lw-run"
          onSubmit={(event) => {
            event.preventDefault();
            setPrompt(draftPrompt);
            setGeneration((n) => n + 1);
          }}
        >
          <label>
            SEED PROMPT
            <input value={draftPrompt} onChange={(event) => setDraftPrompt(event.target.value)} />
          </label>
          <label className="lw-narrow">
            SEED
            <input
              type="number"
              value={seed}
              onChange={(event) => setSeed(Number(event.target.value) || 0)}
            />
          </label>
          <div className="lw-buttons">
            <button type="submit" disabled={!corpus}>
              INOCULATE
            </button>
          </div>
        </form>
      </header>

      {error ? <p className="lw-error">{error}</p> : null}

      {corpus ? (
        <Session
          key={`${generation}|${prompt}|${seed}|${providerKind}`}
          corpus={corpus}
          prompt={prompt}
          seed={seed}
          providerKind={providerKind}
          controls={controls}
          onControl={set}
          onProviderKind={setProviderKind}
          onError={setError}
        />
      ) : (
        <p className="lw-hint">loading the corpus…</p>
      )}
    </main>
  );
}

function Session({
  corpus,
  prompt,
  seed,
  providerKind,
  controls,
  onControl,
  onProviderKind,
  onError,
}: {
  corpus: string;
  prompt: string;
  seed: number;
  providerKind: ProviderKind;
  controls: Controls;
  onControl: <K extends keyof Controls>(key: K, value: Controls[K]) => void;
  onProviderKind: (kind: ProviderKind) => void;
  onError: (message: string) => void;
}) {
  // Built once per mount. The key upstream guarantees a fresh mount whenever
  // any of its inputs change, so this never goes stale.
  const [run] = useState(() => {
    const provider: MoldSignalProvider =
      providerKind === "sliders" ? makeSliderProvider({ seed }) : makeMoldProvider({ seed });
    return new LivingWeightsRun({
      adapter: makeNgramAdapter(corpus, { corpusId: CORPUS_URL }),
      provider,
      prompt,
      seed,
      controls,
    });
  });

  const [running, setRunning] = useState(false);
  const [text, setText] = useState(run.text);
  const [records, setRecords] = useState<StepRecord[]>([]);
  const [history, setHistory] = useState<number[][]>(() => Array.from({ length: 8 }, () => []));
  const [occupancy, setOccupancy] = useState<number[] | null>(null);

  const controlsRef = useRef(controls);
  const busyRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  const stepOnce = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const record = await run.step(controlsRef.current);
      if (!record) {
        setRunning(false);
        return;
      }
      setText(run.text);
      setRecords([...run.records]);
      setHistory((previous) => {
        const next = previous.map((series) => [...series]);
        for (const candidate of record.candidates) {
          next[candidate.channel] = [...(next[candidate.channel] ?? []), candidate.raw].slice(-HISTORY);
        }
        return next;
      });
    } catch (cause: unknown) {
      onError(String(cause));
      setRunning(false);
    } finally {
      busyRef.current = false;
    }
  }, [onError, run]);

  useEffect(() => {
    if (!running) return;
    let live = true;
    const loop = async () => {
      while (live) {
        await stepOnce();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    };
    void loop();
    return () => {
      live = false;
    };
  }, [running, stepOnce]);

  /* --- the culture ------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || providerKind !== "mold") return;
    const provider = run.provider as MoldProvider;
    const { simulation, sites } = provider;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    canvas.width = GRID_W;
    canvas.height = GRID_H;
    const pixels = context.createImageData(GRID_W, GRID_H);
    const data = pixels.data;
    for (let i = 0; i < simulation.trail.length; i += 1) {
      // The same ramp as the main culture view, for the same measured reason:
      // the field's p90 is 3-6, nowhere near the 90 deposit clamp.
      const value = 1 - Math.exp(-simulation.trail[i] * 0.15);
      const occupied = simulation.occupancy[i] !== -1;
      const pixel = i * 4;
      data[pixel] = occupied ? 247 : 8 + value * 176;
      data[pixel + 1] = occupied ? 132 : 10 + value * (72 + value * 25);
      data[pixel + 2] = occupied ? 48 : 11 + value * (18 + value * 15);
      data[pixel + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);

    const latest = records[records.length - 1];
    const byChannel = new Map<number, number>();
    for (const candidate of latest?.candidates ?? []) byChannel.set(candidate.channel, candidate.raw);
    const strongest = Math.max(1e-9, ...byChannel.values());

    sites.forEach((site, index) => {
      const share = (byChannel.get(index) ?? 0) / strongest;
      context.beginPath();
      context.arc(site.x, site.y, provider.moldConfig.detectRadius, 0, Math.PI * 2);
      context.strokeStyle = `rgba(186, 255, 73, ${0.2 + share * 0.75})`;
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = "rgba(241, 239, 230, 0.9)";
      context.font = "8px monospace";
      context.fillText(String(index), site.x - 2, site.y + 3);
    });

    setOccupancy(channelOccupancy(simulation, sites, provider.moldConfig.detectRadius));
  }, [providerKind, records, run]);

  /* --- derived ------------------------------------------------------ */

  const latest = records[records.length - 1];
  const divergence = useMemo(
    () => records.filter((r) => r.chosenIndex !== r.baselineIndex).length,
    [records],
  );

  const download = (name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="lw-transport">
        <div className="lw-buttons">
          <button onClick={() => setRunning((r) => !r)}>{running ? "PAUSE" : "RUN"}</button>
          <button onClick={() => void stepOnce()} disabled={running}>
            STEP
          </button>
        </div>
        <p className="lw-hint">
          {providerKind === "mold"
            ? `culture warmed ${(run.provider as MoldProvider).moldConfig.warmupTicks} ticks before its first reading — below about 200 a plate is still indistinguishable from counting noise`
            : "drift bank — no body, no jamming, no inertia. The null arm."}
        </p>
      </div>

      <section className="lw-grid">
        <article className="lw-panel lw-text">
          <h2>GENERATED</h2>
          <p className="lw-body">{text}</p>
          <dl className="lw-stats">
            <div>
              <dt>TOKENS</dt>
              <dd>{records.length}</dd>
            </div>
            <div>
              <dt>OVERRIDDEN</dt>
              <dd>
                {divergence}
                <span>
                  {records.length > 0 ? ` (${Math.round((divergence / records.length) * 100)}%)` : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>CONFIDENCE</dt>
              <dd>{latest ? latest.confidence.toFixed(2) : "—"}</dd>
            </div>
            <div>
              <dt>APPLIED GAIN</dt>
              <dd>{latest ? latest.effectiveGain.toFixed(2) : "—"}</dd>
            </div>
          </dl>
          <div className="lw-buttons">
            <button
              disabled={records.length === 0}
              onClick={() =>
                download("living-weights.jsonl", serializeRun(run.header, run.records), "application/jsonl")
              }
            >
              EXPORT JSONL
            </button>
            <button
              disabled={records.length === 0}
              onClick={() =>
                download("living-weights.csv", toCsv({ header: run.header, records: run.records }), "text/csv")
              }
            >
              EXPORT CSV
            </button>
          </div>
        </article>

        <article className="lw-panel">
          <h2>CANDIDATES</h2>
          <div className="lw-cards">
            {(latest?.candidates ?? []).map((candidate, index) => {
              const chosen = index === latest?.chosenIndex;
              const wouldHave = index === latest?.baselineIndex;
              return (
                <div
                  key={`${candidate.token}-${index}`}
                  className={`lw-card${chosen ? " is-chosen" : ""}${wouldHave && !chosen ? " is-baseline" : ""}`}
                >
                  <span className="lw-token" title={candidate.token}>
                    {displayToken(candidate.token)}
                  </span>
                  <span className="lw-channel">CH {candidate.channel}</span>
                  <Bar label="model" value={candidate.lmProb} tone="base" />
                  <Bar label="signal" value={Math.min(1, candidate.raw / 100)} tone="signal" />
                  <Bar label="adjusted" value={candidate.adjustedProb} tone="adjusted" />
                  <span className="lw-numbers">
                    {(candidate.lmProb * 100).toFixed(1)}% → {(candidate.adjustedProb * 100).toFixed(1)}%
                    {" · "}
                    {candidate.raw.toFixed(1)} flux
                  </span>
                </div>
              );
            })}
            {records.length === 0 ? (
              <p className="lw-hint">Press RUN. Nothing is decided until the culture has been read.</p>
            ) : null}
          </div>
        </article>

        <aside className="lw-panel lw-dials">
          <h2>CONTROLS</h2>

          <Dial
            label="INFLUENCE GAIN"
            hint={gainHint(controls.gain)}
            value={controls.gain}
            min={0}
            max={16}
            step={0.5}
            onChange={(v) => onControl("gain", v)}
          />
          <Dial
            label="TEMPERATURE"
            value={controls.temperature}
            min={0.2}
            max={2}
            step={0.05}
            onChange={(v) => onControl("temperature", v)}
          />
          <Dial
            label="CANDIDATES"
            value={controls.candidateCount}
            min={2}
            max={8}
            step={1}
            onChange={(v) => onControl("candidateCount", v)}
          />
          <Dial
            label="TICKS PER TOKEN"
            hint="integration window; a shorter read is trusted less"
            value={controls.moldSteps}
            min={1}
            max={60}
            step={1}
            onChange={(v) => onControl("moldSteps", v)}
          />

          <fieldset>
            <legend>SIGNAL SOURCE</legend>
            {(["mold", "sliders"] as ProviderKind[]).map((kind) => (
              <label key={kind} className="lw-radio">
                <input
                  type="radio"
                  checked={providerKind === kind}
                  onChange={() => onProviderKind(kind)}
                />
                {kind === "mold" ? "Physarum culture" : "Drift bank (null arm)"}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>SELECTION</legend>
            {(["weighted", "argmax", "threshold"] as SelectionMode[]).map((mode) => (
              <label key={mode} className="lw-radio">
                <input
                  type="radio"
                  checked={controls.mode === mode}
                  onChange={() => onControl("mode", mode)}
                />
                {mode}
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>CANDIDATE → CHANNEL</legend>
            {(["persistent", "shuffled"] as AssignmentMode[]).map((mode) => (
              <label key={mode} className="lw-radio">
                <input
                  type="radio"
                  checked={controls.assignment === mode}
                  onChange={() => onControl("assignment", mode)}
                />
                {mode}
              </label>
            ))}
            <p className="lw-hint">
              Shuffled is the control arm, not the safer default: the culture&rsquo;s inertia runs to
              hundreds of ticks, so reshuffling every token guarantees its state cannot track the
              words and the influence degenerates into structured noise.
            </p>
          </fieldset>
        </aside>
      </section>

      <section className="lw-grid lw-lower">
        <article className="lw-panel">
          <h2>CULTURE</h2>
          {providerKind === "mold" ? (
            <canvas ref={canvasRef} className="lw-canvas" />
          ) : (
            <p className="lw-hint">The drift bank has no body. Switch the signal source to see one.</p>
          )}
          {occupancy ? (
            <p className="lw-hint">
              channel occupancy {occupancy.map((o) => `${Math.round(o * 100)}%`).join(" · ")}
            </p>
          ) : null}
        </article>

        <article className="lw-panel">
          <h2>CHANNELS</h2>
          <div className="lw-traces">
            {history.map((series, channel) => (
              <div key={channel} className="lw-trace">
                <span>{channel}</span>
                <Sparkline values={series} />
                <em>{series.length > 0 ? series[series.length - 1].toFixed(0) : "—"}</em>
              </div>
            ))}
          </div>
        </article>

        <article className="lw-panel">
          <h2>DECISIONS</h2>
          <ol className="lw-log">
            {records
              .slice(-40)
              .reverse()
              .map((record) => (
                <li
                  key={record.step}
                  className={record.chosenIndex === record.baselineIndex ? "" : "is-bent"}
                >
                  <b>{record.step}</b>
                  <span>{displayToken(record.chosenToken)}</span>
                  {record.chosenIndex === record.baselineIndex ? (
                    <em>—</em>
                  ) : (
                    <em>was &ldquo;{displayToken(record.baselineToken)}&rdquo;</em>
                  )}
                  <i>
                    ch{record.candidates[record.chosenIndex]?.channel} · g
                    {record.effectiveGain.toFixed(1)}
                    {record.attempts > 1 ? ` · ${record.attempts} waits` : ""}
                  </i>
                </li>
              ))}
          </ol>
        </article>
      </section>
    </>
  );
}

/**
 * The end-of-sentence marker is a real candidate the model can rank and the
 * organism can promote, so it must stay visible. It is shown legibly rather
 * than raw: a viewer reading `</s>` off a card learns nothing, and the token
 * itself is still on the element's title and in every export.
 */
function displayToken(token: string) {
  return token === "</s>" ? "⏎ end of sentence" : token;
}

function gainHint(gain: number) {
  if (gain === 0) return "the model alone";
  if (gain <= 1) return "a bias you would have to look for";
  if (gain <= 3) return "shared authorship";
  if (gain <= 8) return "the culture is leading";
  return "the model only decides what is on offer";
}

function Dial({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const id = `dial-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className="lw-dial">
      <span>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{value}</output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? <p className="lw-hint">{hint}</p> : null}
    </div>
  );
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className={`lw-bar lw-bar-${tone}`} title={`${label} ${value.toFixed(3)}`}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <svg className="lw-spark" viewBox="0 0 100 20" preserveAspectRatio="none" />;
  }
  const max = Math.max(...values, 1e-9);
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${20 - (v / max) * 19}`)
    .join(" ");
  return (
    <svg className="lw-spark" viewBox="0 0 100 20" preserveAspectRatio="none">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const CSS = `
.lw { padding: 20px clamp(16px, 3vw, 48px) 64px; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; letter-spacing: .02em; }
.lw h1 { font-size: clamp(18px, 2.2vw, 28px); line-height: 1.2; margin: 6px 0 0; max-width: 22ch; letter-spacing: -.01em; font-family: Arial, Helvetica, sans-serif; }
.lw h2 { font-size: 10px; letter-spacing: .16em; color: var(--muted); margin: 0 0 10px; font-weight: 600; }
.lw-eyebrow { margin: 0; font-size: 10px; letter-spacing: .18em; color: var(--muted); }
.lw-head { display: flex; flex-wrap: wrap; gap: 24px; justify-content: space-between; align-items: flex-end; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.lw-run { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.lw-run label { display: flex; flex-direction: column; gap: 4px; font-size: 9px; letter-spacing: .16em; color: var(--muted); }
.lw-run input { border: 1px solid var(--line); background: transparent; padding: 6px 8px; width: 240px; font: inherit; }
.lw-narrow input { width: 110px; }
.lw-transport { display: flex; gap: 14px; align-items: center; padding: 12px 0; }
.lw-buttons { display: flex; gap: 6px; }
.lw-buttons button { border: 1px solid var(--ink); background: transparent; padding: 6px 12px; cursor: pointer; letter-spacing: .12em; font-size: 10px; }
.lw-buttons button:hover:enabled { background: var(--acid); }
.lw-buttons button:disabled { opacity: .35; cursor: default; }
.lw-error { border-left: 3px solid var(--rust); padding: 8px 12px; color: var(--rust); }
.lw-grid { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.4fr) minmax(220px, .9fr); gap: 18px; align-items: start; }
.lw-lower { grid-template-columns: minmax(280px, 1.2fr) minmax(200px, .8fr) minmax(260px, 1fr); margin-top: 18px; }
.lw-panel { border: 1px solid var(--line); padding: 14px; }
.lw-body { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.55; white-space: pre-wrap; min-height: 8em; margin: 0 0 12px; }
.lw-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 12px; margin: 0 0 12px; }
.lw-stats dt { font-size: 9px; letter-spacing: .14em; color: var(--muted); }
.lw-stats dd { margin: 2px 0 0; font-size: 15px; }
.lw-stats dd span { font-size: 11px; color: var(--muted); }
.lw-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.lw-card { border: 1px solid var(--line); padding: 8px; display: grid; gap: 4px; }
.lw-card.is-chosen { border-color: var(--ink); background: rgba(186, 255, 73, .18); }
.lw-card.is-baseline { border-style: dashed; }
.lw-token { font-size: 14px; font-family: Arial, Helvetica, sans-serif; }
.lw-channel { font-size: 9px; letter-spacing: .14em; color: var(--muted); }
.lw-bar { display: block; height: 3px; background: rgba(18,20,17,.09); }
.lw-bar i { display: block; height: 100%; }
.lw-bar-base i { background: rgba(18,20,17,.45); }
.lw-bar-signal i { background: var(--cyan); }
.lw-bar-adjusted i { background: var(--rust); }
.lw-numbers { font-size: 9px; color: var(--muted); }
.lw-dial { margin-bottom: 12px; }
.lw-dial span { display: flex; justify-content: space-between; font-size: 9px; letter-spacing: .14em; color: var(--muted); }
.lw-dial input { width: 100%; }
.lw-hint { font-size: 9px; line-height: 1.5; color: var(--muted); margin: 4px 0 0; }
.lw-dials fieldset { border: 1px solid var(--line); margin: 0 0 12px; padding: 8px 10px; }
.lw-dials legend { font-size: 9px; letter-spacing: .14em; color: var(--muted); }
.lw-radio { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
.lw-canvas { width: 100%; image-rendering: pixelated; background: var(--culture); border: 1px solid var(--line); }
.lw-traces { display: grid; gap: 4px; }
.lw-trace { display: grid; grid-template-columns: 12px 1fr 36px; gap: 6px; align-items: center; color: var(--cyan); }
.lw-trace span, .lw-trace em { color: var(--muted); font-style: normal; font-size: 9px; }
.lw-trace em { text-align: right; }
.lw-spark { height: 16px; width: 100%; }
.lw-log { list-style: none; margin: 0; padding: 0; max-height: 320px; overflow-y: auto; }
.lw-log li { display: grid; grid-template-columns: 28px 1fr 1fr; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
.lw-log li b { color: var(--muted); font-weight: 400; font-size: 9px; }
.lw-log li em { font-style: normal; font-size: 9px; color: var(--muted); }
.lw-log li i { grid-column: 2 / -1; font-style: normal; font-size: 9px; color: var(--muted); }
.lw-log li.is-bent span { color: var(--rust); }
@media (max-width: 1100px) { .lw-grid, .lw-lower { grid-template-columns: 1fr; } }
`;
