"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  addMarker,
  advanceSimulation,
  defaultMarkers,
  GRID_H,
  GRID_W,
  makeSimulation,
  MAX_AGENTS,
  PRESETS,
  resizePopulation,
  type PresetId,
  type Settings,
  type Simulation,
  TAU,
} from "../lib/physarum-engine";

function Parameter({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / (max - min)) * 100;
  const id = `parameter-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className="parameter">
      <span>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value}
          {unit}
        </output>
      </span>
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={`${value}${unit}`}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--range-progress": `${progress}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Simulation | null>(null);
  const settingsRef = useRef<Settings>(PRESETS.forage.settings);
  const pausedRef = useRef(false);
  const brushRef = useRef<"food" | "light">("food");
  const keyboardCursorRef = useRef({ x: GRID_W / 2, y: GRID_H / 2 });
  const [settings, setSettings] = useState<Settings>(PRESETS.forage.settings);
  const [preset, setPresetState] = useState<PresetId>("forage");
  const [paused, setPaused] = useState(false);
  const [brush, setBrush] = useState<"food" | "light">("food");
  const [seed, setSeed] = useState(41721);
  const [metrics, setMetrics] = useState({ tick: 0, coverage: 0, food: 4 });

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  const reset = useCallback(
    (nextPreset: PresetId = preset, nextSeed = seed, nextSettings = settings) => {
      simRef.current = makeSimulation(nextSettings.population, nextPreset, nextSeed);
      setMetrics({
        tick: 0,
        coverage: 0,
        food: defaultMarkers(nextPreset).filter((marker) => marker.kind === "food").length,
      });
    },
    [preset, seed, settings],
  );

  const choosePreset = (id: PresetId) => {
    const nextSettings = { ...PRESETS[id].settings };
    const nextSeed = seed + 37;
    setPresetState(id);
    setSettings(nextSettings);
    setSeed(nextSeed);
    simRef.current = makeSimulation(nextSettings.population, id, nextSeed);
    setMetrics({
      tick: 0,
      coverage: 0,
      food: defaultMarkers(id).filter((marker) => marker.kind === "food").length,
    });
  };

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "population" && simRef.current) {
      resizePopulation(simRef.current, Number(value));
    }
  };

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let reducedMotionFrame = 0;
    if (reducedMotion) {
      pausedRef.current = true;
      reducedMotionFrame = requestAnimationFrame(() => setPaused(true));
    }
    simRef.current = makeSimulation(settingsRef.current.population, "forage", 41721);

    const offscreen = document.createElement("canvas");
    offscreen.width = GRID_W;
    offscreen.height = GRID_H;
    offscreenRef.current = offscreen;
    const offscreenContext = offscreen.getContext("2d", { alpha: false });
    const pixels = offscreenContext?.createImageData(GRID_W, GRID_H);
    let frame = 0;
    let raf = 0;
    let lastTime = performance.now();
    let accumulator = 0;
    const fixedStepMs = 1000 / 30;

    const render = (time: number) => {
      const sim = simRef.current;
      const canvas = canvasRef.current;
      if (!sim || !canvas || !offscreenContext || !pixels) {
        raf = requestAnimationFrame(render);
        return;
      }

      if (!pausedRef.current) {
        accumulator += Math.min(100, Math.max(0, time - lastTime));
        while (accumulator >= fixedStepMs) {
          for (let i = 0; i < settingsRef.current.speed; i += 1) {
            advanceSimulation(sim, settingsRef.current);
          }
          accumulator -= fixedStepMs;
        }
      } else {
        accumulator = 0;
      }
      lastTime = time;

      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const data = pixels.data;
      for (let i = 0; i < sim.trail.length; i += 1) {
        // Calibrated against the field the sim actually produces, not against
        // the 90 deposit clamp: measured p90 is 3-6 and the maximum ~19, so a
        // gentler ramp left every trail pixel within a few RGB steps of the
        // background and only agent occupancy was ever visible.
        const intensity = 1 - Math.exp(-sim.trail[i] * 0.15);
        const x = i % GRID_W;
        const y = (i / GRID_W) | 0;
        const wave = 0.9 + 0.1 * Math.sin(frame * 0.045 + x * 0.095 - y * 0.07);
        const value = Math.min(1, intensity * wave);
        const pixel = i * 4;
        const occupied = sim.occupancy[i] !== -1;
        data[pixel] = occupied ? 247 : 8 + value * 176;
        data[pixel + 1] = occupied ? 132 : 10 + value * (72 + value * 25);
        data[pixel + 2] = occupied ? 48 : 11 + value * (18 + value * 15);
        data[pixel + 3] = 255;
      }
      offscreenContext.putImageData(pixels, 0, 0);

      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = "#080a09";
      context.fillRect(0, 0, rect.width, rect.height);
      context.imageSmoothingEnabled = true;
      context.drawImage(offscreen, 0, 0, rect.width, rect.height);

      const scaleX = rect.width / GRID_W;
      const scaleY = rect.height / GRID_H;
      for (const marker of sim.markers) {
        const mx = marker.x * scaleX;
        const my = marker.y * scaleY;
        const radius = marker.radius * Math.min(scaleX, scaleY);
        if (marker.kind === "food") {
          const glow = context.createRadialGradient(mx, my, 0, mx, my, radius * 2.4);
          glow.addColorStop(0, `rgba(191, 255, 82, ${0.9 * marker.level})`);
          glow.addColorStop(0.22, `rgba(191, 255, 82, ${0.28 * marker.level})`);
          glow.addColorStop(1, "rgba(191, 255, 82, 0)");
          context.fillStyle = glow;
          context.beginPath();
          context.arc(mx, my, radius * 2.4, 0, TAU);
          context.fill();
          context.strokeStyle = `rgba(224, 255, 170, ${0.75 * marker.level})`;
          context.lineWidth = 1;
          context.beginPath();
          context.arc(mx, my, Math.max(3, radius * 0.48), 0, TAU);
          context.stroke();
        } else {
          context.fillStyle = "rgba(54, 218, 214, 0.055)";
          context.strokeStyle = "rgba(89, 231, 226, 0.7)";
          context.lineWidth = 1;
          context.beginPath();
          context.arc(mx, my, radius, 0, TAU);
          context.fill();
          context.stroke();
          context.beginPath();
          context.moveTo(mx - radius * 0.45, my - radius * 0.45);
          context.lineTo(mx + radius * 0.45, my + radius * 0.45);
          context.moveTo(mx + radius * 0.45, my - radius * 0.45);
          context.lineTo(mx - radius * 0.45, my + radius * 0.45);
          context.stroke();
        }
      }

      context.fillStyle = "rgba(255, 241, 214, 0.72)";
      const skip = Math.max(18, Math.floor(sim.count / 900));
      for (let i = frame % skip; i < sim.count; i += skip) {
        context.fillRect(sim.x[i] * scaleX, sim.y[i] * scaleY, 0.8, 0.8);
      }

      if (document.activeElement === canvas) {
        const cursor = keyboardCursorRef.current;
        const cx = cursor.x * scaleX;
        const cy = cursor.y * scaleY;
        context.strokeStyle = "rgba(241, 239, 230, 0.9)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(cx - 8, cy);
        context.lineTo(cx + 8, cy);
        context.moveTo(cx, cy - 8);
        context.lineTo(cx, cy + 8);
        context.stroke();
      }

      frame += 1;
      if (frame % 20 === 0) {
        setMetrics({
          tick: sim.tick,
          coverage: sim.coverage,
          food: sim.markers.filter((marker) => marker.kind === "food" && marker.level > 0.04)
            .length,
        });
      }
      raf = requestAnimationFrame(render);
    };

    raf = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(reducedMotionFrame);
    };
  }, []);

  const placeMarkerAt = (x: number, y: number, kind: "food" | "light") => {
    const sim = simRef.current;
    if (!sim) return;
    addMarker(sim, { x, y, kind, level: 1, radius: kind === "food" ? 8 : 23 });
  };

  const placeMarker = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * GRID_W;
    const y = ((event.clientY - rect.top) / rect.height) * GRID_H;
    const kind = event.shiftKey ? "light" : brushRef.current;
    placeMarkerAt(x, y, kind);
  };

  const handleCanvasKey = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const cursor = keyboardCursorRef.current;
    const step = event.shiftKey ? 20 : 8;
    if (event.key === "ArrowLeft") cursor.x = Math.max(0, cursor.x - step);
    else if (event.key === "ArrowRight") cursor.x = Math.min(GRID_W - 1, cursor.x + step);
    else if (event.key === "ArrowUp") cursor.y = Math.max(0, cursor.y - step);
    else if (event.key === "ArrowDown") cursor.y = Math.min(GRID_H - 1, cursor.y + step);
    else if (event.key === "Enter" || event.key === " ") {
      placeMarkerAt(cursor.x, cursor.y, brushRef.current);
    } else return;
    event.preventDefault();
  };

  const addRandomMarker = (kind: "food" | "light") => {
    const sim = simRef.current;
    if (!sim) return;
    addMarker(sim, {
      x: 38 + sim.random() * (GRID_W - 76),
      y: 32 + sim.random() * (GRID_H - 64),
      kind,
      level: 1,
      radius: kind === "food" ? 8 : 23,
    });
  };

  const exportFrame = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const anchor = document.createElement("a");
    anchor.download = `myx-physarum-${seed}.png`;
    anchor.href = canvas.toDataURL("image/png");
    anchor.click();
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="MYX home">
          <span className="brand-mark">M</span>
          <span>
            <strong>MYX</strong>
            <small>DIGITAL PLASMODIUM</small>
          </span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#experiment">Experiment</a>
          <a href="#method">Method</a>
          <a href="#sources">Sources</a>
        </nav>
        <div className="header-status">
          <i /> MODEL LIVE
        </div>
      </header>

      <section className="intro" id="top">
        <div>
          <p className="eyebrow">An interactive model of <em>Physarum polycephalum</em></p>
          <h1>
            Intelligence,
            <br />
            <span>without a brain.</span>
          </h1>
        </div>
        <div className="intro-copy">
          <p>
            Watch thousands of simple agents sense, turn, and leave a chemical trace. No map.
            No leader. A living-looking transport network emerges from local decisions.
          </p>
          <a href="#experiment" className="text-link">
            Enter the experiment <span aria-hidden="true">↓</span>
          </a>
        </div>
      </section>

      <section className="experiment" id="experiment" aria-label="Interactive experiment">
        <div className="experiment-heading">
          <div>
            <p className="section-index">01 / LIVE EXPERIMENT</p>
            <h2>Guide the plasmodium</h2>
          </div>
          <p>
            Place food or light directly on the culture. The network responds in real time.
          </p>
        </div>

        <div className="workbench">
          <div className="culture-card">
            <div className="culture-toolbar">
              <div className="live-label">
                <span /> CULTURE A-01
              </div>
              <div className="toolbar-actions">
                <button type="button" onClick={() => setPaused((value) => !value)}>
                  {paused ? "▶ Resume" : "Ⅱ Pause"}
                </button>
                <button type="button" onClick={() => reset()}>
                  ↻ Reset
                </button>
                <button type="button" onClick={exportFrame}>
                  ↓ Capture
                </button>
              </div>
            </div>
            <div className="culture-wrap">
              <canvas
                ref={canvasRef}
                className="culture"
                aria-label="Animated particle simulation of Physarum slime mold growth. Click to place a stimulus, or use arrow keys to move the keyboard cursor and Enter to place it."
                role="img"
                tabIndex={0}
                onPointerDown={placeMarker}
                onKeyDown={handleCanvasKey}
              />
              <div className="canvas-readout top-left">
                <span>T+ {String(metrics.tick).padStart(5, "0")}</span>
                <span>{settings.population.toLocaleString()} AGENTS</span>
              </div>
              <div className="canvas-readout top-right">
                <span>CHEMOTAXIS</span>
                <b>{paused ? "HOLD" : "ACTIVE"}</b>
              </div>
              <div className="legend" aria-hidden="true">
                <span><i className="food-dot" /> NUTRIENT</span>
                <span><i className="light-dot" /> LIGHT</span>
                <span><i className="body-dot" /> BODY</span>
                <span><i className="trail-dot" /> CHEMICAL FIELD</span>
              </div>
              <div className="scanline" />
            </div>
            <div className="culture-caption">
              <span>CLICK TO PLACE {brush === "food" ? "NUTRIENT" : "LIGHT"}</span>
              <span>SHIFT + CLICK = LIGHT</span>
              <span>SEED {seed}</span>
            </div>
          </div>

          <aside className="control-panel" aria-label="Simulation controls">
            <div className="control-section">
              <div className="control-label">BEHAVIOR</div>
              <div className="preset-list">
                {(Object.keys(PRESETS) as PresetId[]).map((id, index) => (
                  <button
                    type="button"
                    className={preset === id ? "preset active" : "preset"}
                    aria-pressed={preset === id}
                    key={id}
                    onClick={() => choosePreset(id)}
                  >
                    <span>0{index + 1}</span>
                    <span>
                      <strong>{PRESETS[id].label}</strong>
                      <small>{PRESETS[id].note}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="control-section">
              <div className="control-label">ENVIRONMENT BRUSH</div>
              <div className="segmented">
                <button
                  type="button"
                  className={brush === "food" ? "active" : ""}
                  aria-pressed={brush === "food"}
                  onClick={() => setBrush("food")}
                >
                  + Nutrient
                </button>
                <button
                  type="button"
                  className={brush === "light" ? "active" : ""}
                  aria-pressed={brush === "light"}
                  onClick={() => setBrush("light")}
                >
                  × Light
                </button>
              </div>
              <div className="quick-actions">
                <button type="button" onClick={() => addRandomMarker("food")}>
                  Place random food
                </button>
                <button type="button" onClick={() => addRandomMarker("light")}>
                  Place random light
                </button>
              </div>
            </div>

            <div className="control-section parameters">
              <div className="control-label">
                MODEL PARAMETERS <span>JONES 2010</span>
              </div>
              <Parameter
                label="Sensor angle"
                value={settings.sensorAngle}
                min={10}
                max={80}
                step={2.5}
                unit="°"
                onChange={(value) => updateSetting("sensorAngle", value)}
              />
              <Parameter
                label="Rotation angle"
                value={settings.turnAngle}
                min={10}
                max={90}
                step={5}
                unit="°"
                onChange={(value) => updateSetting("turnAngle", value)}
              />
              <Parameter
                label="Sensor offset"
                value={settings.sensorOffset}
                min={3}
                max={18}
                step={1}
                unit=" px"
                onChange={(value) => updateSetting("sensorOffset", value)}
              />
              <Parameter
                label="Trail persistence"
                value={Math.round(settings.decay * 100)}
                min={82}
                max={98}
                step={1}
                unit="%"
                onChange={(value) => updateSetting("decay", value / 100)}
              />
              <Parameter
                label="Population"
                value={settings.population / 1000}
                min={6}
                max={MAX_AGENTS / 1000}
                step={1}
                unit="k"
                onChange={(value) => updateSetting("population", value * 1000)}
              />
            </div>

            <div className="instrument-readout">
              <div>
                <small>FIELD COVERAGE</small>
                <strong>{metrics.coverage.toFixed(1)}%</strong>
              </div>
              <div>
                <small>ACTIVE FOOD</small>
                <strong>{String(metrics.food).padStart(2, "0")}</strong>
              </div>
              <div>
                <small>UPDATE RATE</small>
                <strong>{settings.speed}×</strong>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <section className="method" id="method">
        <div className="method-title">
          <p className="section-index">02 / THE MECHANISM</p>
          <h2>Three sensors.<br />One emergent network.</h2>
          <p>
            This is a qualitative, agent-based approximation—not a cellular or fluid-dynamics
            model of a real organism. Its rules are deliberately small enough to inspect.
          </p>
        </div>
        <ol className="mechanism-list">
          <li>
            <span>01</span>
            <div><strong>Sense</strong><p>Each agent samples the chemical field ahead, left, and right.</p></div>
            <b>F · FL · FR</b>
          </li>
          <li>
            <span>02</span>
            <div><strong>Turn + move</strong><p>It rotates toward the strongest sample, then advances one cell.</p></div>
            <b>θ ± 45°</b>
          </li>
          <li>
            <span>03</span>
            <div><strong>Deposit</strong><p>Movement leaves a local chemoattractant trace for nearby agents.</p></div>
            <b>+ 5 units</b>
          </li>
          <li>
            <span>04</span>
            <div><strong>Diffuse + decay</strong><p>A 3 × 3 mean filter spreads and attenuates the trail field.</p></div>
            <b>3 × 3 mean</b>
          </li>
          <li>
            <span>05</span>
            <div><strong>Occupy + collide</strong><p>At most one agent may occupy a lattice site. A blocked move randomizes its heading and deposits nothing.</p></div>
            <b>≤ 1 / cell</b>
          </li>
        </ol>
      </section>

      <section className="evidence" id="sources">
        <div className="evidence-head">
          <p className="section-index">03 / SCIENTIFIC BASIS</p>
          <h2>Model provenance</h2>
        </div>
        <div className="source-grid">
          <a
            href="https://doi.org/10.1162/artl.2010.16.2.16202"
            target="_blank"
            rel="noreferrer"
          >
            <span>PRIMARY MODEL</span>
            <strong>Jones, J. (2010)</strong>
            <p>Particle chemotaxis, sensor geometry, deposition, diffusion, and pattern regimes.</p>
            <b>ARTIFICIAL LIFE 16(2) ↗</b>
          </a>
          <a
            href="https://doi.org/10.1126/science.1177894"
            target="_blank"
            rel="noreferrer"
          >
            <span>BIOLOGICAL NETWORKS</span>
            <strong>Tero et al. (2010)</strong>
            <p>Experimental evidence for efficient, fault-tolerant Physarum transport networks.</p>
            <b>SCIENCE 327(5964) ↗</b>
          </a>
          <a
            href="https://doi.org/10.1073/pnas.1618114114"
            target="_blank"
            rel="noreferrer"
          >
            <span>BIOLOGICAL CONTEXT</span>
            <strong>Alim et al. (2017)</strong>
            <p>Experimental analysis of signal propagation and peristaltic flow in living Physarum.</p>
            <b>PNAS 114(20) ↗</b>
          </a>
        </div>
        <div className="limits">
          <span>MODEL SCOPE</span>
          <p>
            Bright orange pixels are agent occupancy; the dim amber haze is deposited chemical
            field. Nutrient attraction uses +4300L/(d²+42), where L is food remaining. Light uses
            −8500/(d²+65) plus a marked
            exclusion radius. These are explicit visual-model extensions, not calibrated biological
            concentrations. The brightness pulse is an activity cue—not a Navier–Stokes simulation
            of shuttle streaming. Boundaries are periodic; time and distance use simulation units.
          </p>
        </div>
      </section>

      <footer>
        <div className="brand footer-brand">
          <span className="brand-mark">M</span>
          <span><strong>MYX</strong><small>DIGITAL PLASMODIUM</small></span>
        </div>
        <p>Built to make emergence visible.</p>
        <a href="#top">RETURN TO TOP ↑</a>
      </footer>
    </main>
  );
}
