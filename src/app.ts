import "./styles.css";
import { FRONT_PANEL_KEYS, type FrontPanelKey } from "./devices";

const BINDABLE_KEYS = new Set<FrontPanelKey>(FRONT_PANEL_KEYS);
import { hex } from "./memory";
import { formatTrace, type TraceEntry } from "./mcs51";
import { UA8295LinkedPair } from "./radio-link";
import { loadBundledRomSet, loadRomSetFromFiles, ROM_SPECS, type RomSet } from "./roms";
import { UA8295Machine } from "./ua8295";
import { formatTraceEvent, summarizeTraceEvents, type CpuName, type TraceEventKind } from "./trace";

const state: {
  roms: RomSet | null;
  machine: UA8295Machine | null;
  peerMachine: UA8295Machine | null;
  linkedPair: UA8295LinkedPair | null;
  activeCpu: CpuName;
  trace: TraceEntry[];
  ioCpuFilter: CpuName | "device" | "all";
  ioKindFilter: TraceEventKind | "all";
  traceAllXdata: boolean;
  continuousRun: boolean;
  uiMode: "device" | "developer";
  appMode: "single" | "transmission";
  activeTerminal: "a" | "b";
  status: string;
} = {
  roms: null,
  machine: null,
  peerMachine: null,
  linkedPair: null,
  activeCpu: "main",
  trace: [],
  ioCpuFilter: "all",
  ioKindFilter: "all",
  traceAllXdata: false,
  continuousRun: false,
  uiMode: "device",
  appMode: "single",
  activeTerminal: "a",
  status: "Load ROMs to start."
};

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("Missing #app root");
}
const app = appElement;
let animationHandle: number | null = null;
let continuousFrameCount = 0;
let globalKeyboardAttached = false;
const SRAM_STORAGE_PREFIX = "ua8295.sram.v1";
const physicalKeysDown = new Map<string, { key: FrontPanelKey; terminal: "a" | "b" }>();
// Maps host-keyboard codes (event.key, event.code) to FrontPanelKey targets. The
// real device keyboard is uppercase-only, so a-z host keys all route to the
// uppercase letter entries. Letter shortcuts to function keys ("c" → CONF,
// "t" → TIME, etc.) are intentionally NOT included now that the alphabetic keys
// are bound; users can still reach the function keys via their on-screen labels
// or the side column. Shift behaves as the physical SHIFT (`^`) modifier.
const PHYSICAL_KEY_MAP = new Map<string, FrontPanelKey>([
  ["Backspace", "DEL"],
  ["Delete", "DEL"],
  ["Escape", "SHORT_TERM"],
  ["Shift", "^"],
  ["Enter", "="],
  [" ", "SPACE"],
  ["ArrowLeft", "SCROLL_LEFT"],
  ["ArrowRight", "SCROLL_RIGHT"],
  [",", ","],
  [".", "."],
  ["-", "-"],
  ["=", "="],
  // Digits.
  ["0", "0"],
  ["1", "1"],
  ["2", "2"],
  ["3", "3"],
  ["4", "4"],
  ["5", "5"],
  ["6", "6"],
  ["7", "7"],
  ["8", "8"],
  ["9", "9"],
  // Alphas (lowercase host keys → uppercase device keys).
  ["a", "A"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["f", "F"], ["g", "G"],
  ["h", "H"], ["i", "I"], ["j", "J"], ["k", "K"], ["l", "L"], ["m", "M"], ["n", "N"],
  ["o", "O"], ["p", "P"], ["q", "Q"], ["r", "R"], ["s", "S"], ["t", "T"], ["u", "U"],
  ["v", "V"], ["w", "W"], ["x", "X"], ["y", "Y"], ["z", "Z"]
]);

queueMicrotask(render);
queueMicrotask(installDebugSurface);
window.addEventListener("pagehide", persistTerminalMemory);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistTerminalMemory();
});

declare global {
  interface Window {
    __ua8295?: {
      pressKey: (k: FrontPanelKey) => void;
      releaseKey: (k: FrontPanelKey) => void;
      probe: () => Record<string, unknown>;
    };
  }
}

function installDebugSurface(): void {
  window.__ua8295 = {
    pressKey: (k) => setKey(k, true),
    releaseKey: (k) => setKey(k, false),
    probe: () => ({
      display: state.machine?.hardware.display.displayLine(),
      pressedKeys: state.machine?.hardware.keyboard.pressedKeys() ?? [],
      heldKeys: Array.from(heldKeys.entries()).map(([id, value]) => ({ id, ...value })),
      mainPC: state.machine?.mainCpu.snapshot().pc.toString(16),
      iram1c: state.machine?.mainCpu.iram[0x1c].toString(16),
      iram20: state.machine?.mainCpu.iram[0x20].toString(16),
      continuousRun: state.continuousRun,
      status: state.status
    })
  };
}

function render(): void {
  app.classList.toggle("is-transmission-mode", state.appMode === "transmission");
  const cpu = state.machine?.cpu(state.activeCpu);
  const snapshot = cpu?.snapshot();
  const ioEvents = state.machine?.traceLog.recent(300, {
    cpu: state.ioCpuFilter,
    kind: state.ioKindFilter
  }) ?? [];
  const ioSummary = summarizeTraceEvents(state.machine?.traceLog.events ?? []);
  const romRows = Object.values(ROM_SPECS)
    .map((spec) => {
      const image = state.roms?.[spec.key];
      return `<tr><td>${spec.filename}</td><td>${image ? "loaded" : "missing"}</td><td>${image?.digest.slice(0, 12) ?? "-"}</td></tr>`;
    })
    .join("");

  app.innerHTML = `
    <header class="top-bar">
      <div>
        <strong>UA-8295 Emulator</strong>
        <span>${state.status}</span>
        <div class="rom-badges">${renderRomBadges()}</div>
      </div>
      <div class="top-actions">
        <button data-action="load-bundled">Load bundled ROMs</button>
        <button data-action="continuous" ${state.machine ? "" : "disabled"}>${state.continuousRun ? "Pause" : "Run"}</button>
        <button data-action="toggle-app-mode" ${state.machine ? "" : "disabled"}>${state.appMode === "single" ? "Transmission Test" : "Single Unit"}</button>
        <button data-action="toggle-ui-mode">${state.uiMode === "developer" ? "Device Mode" : "Developer Mode"}</button>
      </div>
    </header>

    <section class="hero">
      <div>
        <p class="eyebrow">Philips UA-8295 / Nokia DA-8520</p>
        <h1>${state.uiMode === "developer" ? "Browser ROM Emulator" : "Short-Burst Message Terminal"}</h1>
        <p>${state.uiMode === "developer" ? "Developer Mode exposes CPU state, ROM validation, traces, and decoded I/O while the device peripherals are reverse engineered." : "Device Mode presents the firmware-driven terminal without the engineering panels. Load the bundled ROMs, run the device, and operate the front-panel keys."}</p>
      </div>
      <div class="link-status">${state.appMode === "transmission" ? `Radio link: ${state.linkedPair?.link.status() ?? "disconnected"}` : "Single terminal"}</div>
      <div class="terminals-grid ${state.appMode === "transmission" ? "is-linked" : "is-single"}">
        ${renderTerminal(state.machine, "a", state.appMode === "transmission" ? "TERMINAL A" : "PHILIPS USFA UA-8295/00")}
        ${state.appMode === "transmission" ? renderTerminal(state.peerMachine, "b", "TERMINAL B") : ""}
      </div>
    </section>

    ${
      state.uiMode === "developer"
        ? `
    <section class="panel controls">
      <button data-action="load-bundled">Load bundled ROMs</button>
      <label class="file-button">
        Select ROM files
        <input data-action="select-roms" type="file" multiple accept=".bin" />
      </label>
      <select data-action="cpu">
        <option value="main" ${state.activeCpu === "main" ? "selected" : ""}>Main CPU</option>
        <option value="iop" ${state.activeCpu === "iop" ? "selected" : ""}>I/O Processor</option>
      </select>
      <button data-action="reset" ${state.machine ? "" : "disabled"}>Reset</button>
      <button data-action="step" ${state.machine ? "" : "disabled"}>Step</button>
      <button data-action="run-1000" ${state.machine ? "" : "disabled"}>Run 1,000</button>
      <button data-action="run-10000" ${state.machine ? "" : "disabled"}>Run 10,000</button>
      <button data-action="run-both-1000" ${state.machine ? "" : "disabled"}>Run Both 1,000</button>
      <button data-action="run-frame" ${state.machine ? "" : "disabled"}>Run Frame</button>
      <button data-action="continuous" ${state.machine ? "" : "disabled"}>${state.continuousRun ? "Pause" : "Run Continuous"}</button>
      <label class="checkbox">
        <input data-action="trace-all-xdata" type="checkbox" ${state.traceAllXdata ? "checked" : ""} />
        Trace SRAM/text ROM MOVX
      </label>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>CPU State</h2>
        ${snapshot ? renderSnapshot(snapshot) : "<p>No CPU loaded yet.</p>"}
        <p class="status">${state.status}</p>
      </div>
      <div class="panel">
        <h2>ROM Set</h2>
        <table><thead><tr><th>File</th><th>Status</th><th>SHA-256</th></tr></thead><tbody>${romRows}</tbody></table>
      </div>
    </section>

    <section class="panel">
      <h2>Trace</h2>
      <pre>${state.trace.slice(-300).map(formatTrace).join("\n") || "No trace yet."}</pre>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <h2>I/O Trace</h2>
        <button data-action="clear-io" ${state.machine ? "" : "disabled"}>Clear I/O Trace</button>
      </div>
      <div class="trace-controls">
        <label>
          CPU
          <select data-action="io-cpu-filter">
            ${renderOption("all", "All", state.ioCpuFilter)}
            ${renderOption("main", "Main", state.ioCpuFilter)}
            ${renderOption("iop", "I/O Processor", state.ioCpuFilter)}
            ${renderOption("device", "Device Scheduler", state.ioCpuFilter)}
          </select>
        </label>
        <label>
          Kind
          <select data-action="io-kind-filter">
            ${renderOption("all", "All", state.ioKindFilter)}
            ${renderOption("movx", "MOVX", state.ioKindFilter)}
            ${renderOption("sfr", "SFR", state.ioKindFilter)}
            ${renderOption("port", "Port", state.ioKindFilter)}
            ${renderOption("scheduler", "Scheduler", state.ioKindFilter)}
            ${renderOption("timer", "Timer", state.ioKindFilter)}
            ${renderOption("interrupt", "Interrupt", state.ioKindFilter)}
          </select>
        </label>
      </div>
      <div class="histograms">
        <div>
          <h3>SFR/Port Hotspots</h3>
          <ol>${renderHistogram(ioSummary.sfr)}</ol>
        </div>
        <div>
          <h3>XDATA Ranges</h3>
          <ol>${renderHistogram(ioSummary.xdata)}</ol>
        </div>
      </div>
      <pre>${ioEvents.map(formatTraceEvent).join("\n") || "No I/O events yet."}</pre>
    </section>

    <section class="panel">
      <h2>Memory Map</h2>
      <ul>${state.machine?.describeMemoryMap().map((line) => `<li>${line}</li>`).join("") ?? "<li>Load ROMs to initialize the machine.</li>"}</ul>
    </section>
    `
        : ""
    }
  `;

  app.querySelector('[data-action="load-bundled"]')?.addEventListener("click", () => void loadBundled());
  app.querySelector<HTMLInputElement>('[data-action="select-roms"]')?.addEventListener("change", (event: Event) => {
    const input = event.currentTarget;
    if (input instanceof HTMLInputElement && input.files) void loadFiles(input.files);
  });
  app.querySelector<HTMLSelectElement>('[data-action="cpu"]')?.addEventListener("change", (event: Event) => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    state.activeCpu = select.value as CpuName;
    state.trace = [];
    render();
  });
  app.querySelector('[data-action="reset"]')?.addEventListener("click", resetActive);
  app.querySelector('[data-action="step"]')?.addEventListener("click", () => runSteps(1));
  app.querySelector('[data-action="run-1000"]')?.addEventListener("click", () => runSteps(1000));
  app.querySelector('[data-action="run-10000"]')?.addEventListener("click", () => runSteps(10000));
  app.querySelector('[data-action="run-both-1000"]')?.addEventListener("click", () => runBoth(1000));
  app.querySelector('[data-action="run-frame"]')?.addEventListener("click", () => runFrame());
  app.querySelector('[data-action="continuous"]')?.addEventListener("click", toggleContinuousRun);
  app.querySelector('[data-action="toggle-app-mode"]')?.addEventListener("click", toggleAppMode);
  app.querySelector('[data-action="toggle-ui-mode"]')?.addEventListener("click", toggleUiMode);
  app.querySelector<HTMLInputElement>('[data-action="trace-all-xdata"]')?.addEventListener("change", (event: Event) => {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    state.traceAllXdata = input.checked;
    if (state.machine) state.machine.traceOptions.traceAllXdata = input.checked;
    render();
  });
  app.querySelector<HTMLSelectElement>('[data-action="io-cpu-filter"]')?.addEventListener("change", (event: Event) => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    state.ioCpuFilter = select.value as typeof state.ioCpuFilter;
    render();
  });
  app.querySelector<HTMLSelectElement>('[data-action="io-kind-filter"]')?.addEventListener("change", (event: Event) => {
    const select = event.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    state.ioKindFilter = select.value as typeof state.ioKindFilter;
    render();
  });
  app.querySelector('[data-action="clear-io"]')?.addEventListener("click", clearIoTrace);
  app.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((button) => {
    const key = button.dataset.key as FrontPanelKey | undefined;
    const terminal = button.dataset.terminal === "b" ? "b" : "a";
    if (!key) return;
    button.addEventListener("pointerdown", (event: PointerEvent) => {
      button.setPointerCapture(event.pointerId);
      state.activeTerminal = terminal;
      setKey(key, true, terminal);
    });
    button.addEventListener("pointerup", () => setKey(key, false, terminal));
    button.addEventListener("pointercancel", () => setKey(key, false, terminal));
    button.addEventListener("pointerleave", () => setKey(key, false, terminal));
    button.addEventListener("keydown", (event) => {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) setKey(key, true, terminal);
    });
    button.addEventListener("keyup", () => setKey(key, false, terminal));
  });
  attachGlobalKeyboard();
}

async function loadBundled(): Promise<void> {
  try {
    state.status = "Loading bundled ROM assets...";
    render();
    installMachine(await loadBundledRomSet(), "Loaded bundled ROMs.");
  } catch (error) {
    state.status = `ROM load failed: ${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

async function loadFiles(files: FileList): Promise<void> {
  try {
    state.status = "Validating selected ROM files...";
    render();
    installMachine(await loadRomSetFromFiles(files), "Loaded selected ROM files.");
  } catch (error) {
    state.status = `ROM load failed: ${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

function installMachine(roms: RomSet, status: string): void {
  stopContinuousRun();
  state.roms = roms;
  state.machine = new UA8295Machine(roms, {
    cpuTrace: {
      traceAllXdata: state.traceAllXdata
    }
  });
  state.peerMachine = new UA8295Machine(roms, {
    cpuTrace: { traceAllXdata: state.traceAllXdata }
  });
  state.linkedPair = new UA8295LinkedPair(state.machine, state.peerMachine);
  restoreTerminalMemory(state.machine, "a");
  restoreTerminalMemory(state.peerMachine, "b");
  state.trace = [];
  state.status = status;
  applyTraceRecordingForMode();
  render();
}

function resetActive(): void {
  state.machine?.cpu(state.activeCpu).reset();
  state.trace = [];
  stopContinuousRun();
  state.status = `${state.activeCpu} CPU reset.`;
  render();
}

function runSteps(steps: number): void {
  const machine = state.machine;
  if (!machine) return;
  try {
    appendInstructionTrace(machine.runCpu(state.activeCpu, steps, true));
    state.status = `Ran ${steps.toLocaleString()} ${state.activeCpu} CPU instructions.`;
  } catch (error) {
    state.status = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}

function runBoth(steps: number): void {
  const machine = state.machine;
  if (!machine) return;
  try {
    const result = machine.runScheduler(steps, 1, true);
    appendInstructionTrace([...result.main, ...result.iop]);
    state.status = `Ran ${steps.toLocaleString()} scheduler slices across both CPUs.`;
  } catch (error) {
    state.status = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}

function runFrame(renderAfter = true): void {
  const machine = state.machine;
  if (!machine) return;
  try {
    const trace = state.uiMode === "developer";
    const result = machine.runScheduler(40, 80, trace);
    if (trace) appendInstructionTrace([...result.main, ...result.iop]);
    state.status = "Ran one scheduler frame.";
  } catch (error) {
    stopContinuousRun();
    state.status = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
    render();
    return;
  }
  if (renderAfter) render();
}

/**
 * Run as many scheduler slices as fit in `budgetMs` of real time. Targets
 * near-real-device CPU speed without ever blowing past one animation frame.
 *
 * The 80C31 ran at ~922k instructions/sec; at 60 FPS that's ~15k instructions
 * per frame. With a 12 ms budget out of a 16.7 ms frame we get plenty of
 * headroom for the browser to paint and respond to input. The previous fixed
 * `runScheduler(40, 80)` only emulated ~3,200 instructions/frame (~20% of
 * real speed), which left key-press handshakes too short to advance prompts.
 */
function runFrameTimeBudgeted(budgetMs: number = 12): void {
  const machine = state.machine;
  if (!machine) return;
  const start = performance.now();
  // Larger chunks amortize the per-call overhead of `runScheduler` (which
  // currently allocates a result array and pushes per-instruction trace entries
  // even when tracing is off). 64 slices ≈ 5,120 instructions/CPU per call.
  const SLICES_PER_CHUNK = 64;
  try {
    while (performance.now() - start < budgetMs) {
      if (state.appMode === "transmission" && state.linkedPair) {
        state.linkedPair.runScheduler(SLICES_PER_CHUNK, 80, false);
      } else {
        machine.runScheduler(SLICES_PER_CHUNK, 80, false);
      }
      advanceKeyHolds(SLICES_PER_CHUNK);
    }
  } catch (error) {
    stopContinuousRun();
    state.status = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

/**
 * Cheap per-frame render that only touches the display cells and the
 * indicator/status surfaces — no full DOM rebuild, no event-handler churn.
 * Falls back to a full `render()` if the partial DOM hasn't been built yet.
 */
function renderDeviceTick(): void {
  if (!state.machine) return;
  const bezels = app.querySelectorAll<HTMLElement>(".display-bezel[data-terminal]");
  if (!bezels.length) {
    render();
    return;
  }
  for (const bezel of bezels) {
    const terminal = bezel.dataset.terminal === "b" ? "b" : "a";
    const machine = machineFor(terminal);
    if (machine) bezel.innerHTML = renderDisplay(machine.hardware.display.displayLine(), machine.hardware.display.brightnessLevel());
  }
  const linkStatus = app.querySelector<HTMLElement>(".link-status");
  if (linkStatus) linkStatus.textContent = state.appMode === "transmission" ? `Radio link: ${state.linkedPair?.link.status() ?? "disconnected"}` : "Single terminal";
  const status = app.querySelector<HTMLElement>(".top-bar span");
  if (status) status.textContent = state.status;
}

function toggleContinuousRun(): void {
  if (state.continuousRun) {
    stopContinuousRun();
    state.status = "Continuous run paused.";
    render();
    return;
  }
  state.continuousRun = true;
  continuousFrameCount = 0;
  state.status = "Continuous run active.";
  scheduleContinuousRun();
  render();
}

function toggleUiMode(): void {
  state.uiMode = state.uiMode === "developer" ? "device" : "developer";
  state.status = state.uiMode === "developer" ? "Developer Mode active." : "Device Mode active.";
  applyTraceRecordingForMode();
  render();
}

function toggleAppMode(): void {
  state.appMode = state.appMode === "single" ? "transmission" : "single";
  if (state.appMode === "single") state.activeTerminal = "a";
  state.status = state.appMode === "transmission" ? "Two linked terminals active." : "Single terminal active.";
  render();
}

/**
 * The trace log is the dominant per-instruction cost in the emulator. Disable
 * it whenever we're in pure Device Mode (the user only cares about the
 * firmware behavior); enable it again when the developer panel is visible.
 */
function applyTraceRecordingForMode(): void {
  state.machine?.traceLog.setRecording(state.uiMode === "developer");
  state.peerMachine?.traceLog.setRecording(state.uiMode === "developer");
}

function scheduleContinuousRun(): void {
  if (!state.continuousRun) return;
  animationHandle = requestAnimationFrame(() => {
    continuousFrameCount += 1;
    runFrameTimeBudgeted(12);
    if (continuousFrameCount % 90 === 0) persistTerminalMemory();
    if (state.uiMode === "device") {
      // Cheap partial render every animation frame keeps the display fluid.
      renderDeviceTick();
    } else if (continuousFrameCount % 30 === 0) {
      // Developer mode needs the trace + summary panels refreshed periodically;
      // every 30 frames (~0.5 s) is enough and avoids churning the DOM.
      render();
    } else {
      // In dev mode between full renders, still keep the display visible.
      renderDeviceTick();
    }
    scheduleContinuousRun();
  });
}

function stopContinuousRun(): void {
  state.continuousRun = false;
  if (animationHandle !== null) {
    cancelAnimationFrame(animationHandle);
    animationHandle = null;
  }
}

function appendInstructionTrace(entries: TraceEntry[]): void {
  state.trace.push(...entries);
  if (state.trace.length > 2_000) {
    state.trace.splice(0, state.trace.length - 2_000);
  }
}

function clearIoTrace(): void {
  state.machine?.traceLog.clear();
  state.status = "Cleared I/O trace.";
  render();
}

/**
 * Minimum number of scheduler slices a key must remain "pressed" before we
 * honor a release request. This guarantees the firmware's keyboard scan +
 * bit-banged P3.3 handshake + 0x080D dispatcher all get enough CPU time to
 * complete, regardless of how fast the user clicks (browser-synthesized clicks
 * fire pointerdown and pointerup within a millisecond).
 *
 * Tied to scheduler progress rather than wallclock so the model is robust
 * against animation-frame throttling (e.g. backgrounded tabs) and matches the
 * semantics our headless tests rely on (which all hold for >=250 slices).
 *
 * 800 slices × 80 instructions ≈ 64 k main-CPU instructions ≈ 70 ms of real
 * 11 MHz device time — well above the ~5–15 k the firmware actually needs.
 */
const MIN_KEY_HOLD_SLICES = 800;
type HeldKeyState = { slicesHeld: number; releaseRequested: boolean };
const heldKeys = new Map<string, HeldKeyState & { key: FrontPanelKey; terminal: "a" | "b" }>();

function setKey(key: FrontPanelKey, isPressed: boolean, terminal: "a" | "b" = state.activeTerminal): void {
  const machine = machineFor(terminal);
  if (!machine) return;
  const heldId = `${terminal}:${key}`;
  if (isPressed) {
    heldKeys.set(heldId, { key, terminal, slicesHeld: 0, releaseRequested: false });
    machine.hardware.keyboard.setPressed(key, true);
    setStatus(`Pressed ${key}.`);
    return;
  }
  const entry = heldKeys.get(heldId);
  if (!entry) return;
  entry.releaseRequested = true;
  if (entry.slicesHeld >= MIN_KEY_HOLD_SLICES) {
    machine.hardware.keyboard.setPressed(key, false);
    heldKeys.delete(heldId);
    setStatus(`Released ${key}.`);
  }
}

/**
 * Advances `slicesHeld` for every currently-pressed key by `slicesRun`, and
 * fires the actual `setPressed(false)` once a release has been requested AND
 * the minimum hold has been satisfied.
 */
function advanceKeyHolds(slicesRun: number): void {
  if (heldKeys.size === 0 || slicesRun <= 0) return;
  for (const [heldId, entry] of heldKeys) {
    const machine = machineFor(entry.terminal);
    if (!machine) continue;
    entry.slicesHeld += slicesRun;
    if (entry.releaseRequested && entry.slicesHeld >= MIN_KEY_HOLD_SLICES) {
      machine.hardware.keyboard.setPressed(entry.key, false);
      heldKeys.delete(heldId);
    }
  }
}

function setStatus(text: string): void {
  state.status = text;
  const statusEl = app.querySelector<HTMLElement>(".top-bar span");
  if (statusEl) statusEl.textContent = text;
}

function persistTerminalMemory(): void {
  for (const terminal of ["a", "b"] as const) {
    const machine = machineFor(terminal);
    if (!machine) continue;
    try {
      const bytes = machine.mainBus.xram;
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x1000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x1000));
      }
      localStorage.setItem(`${SRAM_STORAGE_PREFIX}.${terminal}`, btoa(binary));
    } catch {
      // Storage can be unavailable in private contexts; the emulator remains usable.
    }
  }
}

function restoreTerminalMemory(machine: UA8295Machine, terminal: "a" | "b"): void {
  try {
    const encoded = localStorage.getItem(`${SRAM_STORAGE_PREFIX}.${terminal}`);
    if (!encoded) return;
    const binary = atob(encoded);
    const length = Math.min(binary.length, machine.mainBus.xram.length);
    for (let index = 0; index < length; index += 1) {
      machine.mainBus.xram[index] = binary.charCodeAt(index) & 0xff;
    }
  } catch {
    // Ignore corrupt or inaccessible saved memory and use clean emulated SRAM.
  }
}

function attachGlobalKeyboard(): void {
  if (globalKeyboardAttached) return;
  globalKeyboardAttached = true;
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    const key = PHYSICAL_KEY_MAP.get(event.key) ?? PHYSICAL_KEY_MAP.get(event.key.toLowerCase());
    if (!key || event.repeat || isTypingTarget(event.target)) return;
    const terminal = state.activeTerminal;
    physicalKeysDown.set(event.code, { key, terminal });
    setKey(key, true, terminal);
    event.preventDefault();
  });
  window.addEventListener("keyup", (event: KeyboardEvent) => {
    const pressed = physicalKeysDown.get(event.code);
    if (!pressed) return;
    physicalKeysDown.delete(event.code);
    setKey(pressed.key, false, pressed.terminal);
    event.preventDefault();
  });
  window.addEventListener("blur", () => {
    for (const pressed of physicalKeysDown.values()) setKey(pressed.key, false, pressed.terminal);
    physicalKeysDown.clear();
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function renderSnapshot(snapshot: ReturnType<UA8295Machine["mainCpu"]["snapshot"]>): string {
  return `
    <dl class="snapshot">
      <dt>PC</dt><dd>0x${hex(snapshot.pc, 4)}</dd>
      <dt>A</dt><dd>0x${hex(snapshot.a, 2)}</dd>
      <dt>B</dt><dd>0x${hex(snapshot.b, 2)}</dd>
      <dt>PSW</dt><dd>0x${hex(snapshot.psw, 2)}</dd>
      <dt>SP</dt><dd>0x${hex(snapshot.sp, 2)}</dd>
      <dt>DPTR</dt><dd>0x${hex(snapshot.dptr, 4)}</dd>
      <dt>Cycles</dt><dd>${snapshot.cycles.toLocaleString()}</dd>
    </dl>
  `;
}

function displayLine(snapshot: ReturnType<UA8295Machine["mainCpu"]["snapshot"]> | undefined): string {
  if (!snapshot) return "LOAD ROMS";
  return `${state.activeCpu.toUpperCase()} PC ${hex(snapshot.pc, 4)}  A ${hex(snapshot.a, 2)}`;
}

function machineFor(terminal: "a" | "b"): UA8295Machine | null {
  return terminal === "a" ? state.machine : state.peerMachine;
}

function renderTerminal(machine: UA8295Machine | null, terminal: "a" | "b", label: string): string {
  const displayText = machine?.hardware.display.displayLine() ?? displayLine(undefined);
  const active = state.activeTerminal === terminal ? " is-active" : "";
  return `
    <section class="terminal-shell${active}" data-terminal="${terminal}">
      <div class="terminal-heading">
        <strong>${escapeHtml(label)}</strong>
        ${state.appMode === "transmission" ? `<span>${terminal === "a" ? "Sender / receiver A" : "Sender / receiver B"}</span>` : ""}
      </div>
      <div class="device">
        <div class="device-label">PHILIPS USFA UA-8295/00</div>
        <div class="display-section">
          <div class="display-bezel" data-terminal="${terminal}">${renderDisplay(displayText, machine?.hardware.display.brightnessLevel())}</div>
          <div class="indicator-panel">
            <div class="indicator-row">
              <span>BATTERY LOW</span>
              <span>CHARGE</span>
              <span class="${machine?.receiveMessageIndicatorLit() ? "is-on" : ""}">MESSAGE</span>
              <span class="${machine?.hardware.modemRadio.isTransmitting() ? "is-on" : ""}">TRANSMIT</span>
            </div>
            <div class="brand">PHILIPS<br>USFA B.V</div>
          </div>
        </div>
        <div class="keyboard">${renderKeys(terminal)}</div>
        ${state.uiMode === "developer" ? `<div class="keyboard-status">${machine?.hardware.keyboard.describe() ?? "Keyboard inactive"}</div><div class="display-details">${renderDisplayDetails(machine)}</div>` : ""}
      </div>
    </section>
  `;
}

type KeyVariant =
  | "digit"
  | "letter"
  | "punct"
  | "fn"
  | "shift"
  | "scroll"
  | "space"
  | "send"
  | "side";

type KeySpec = {
  /** Canonical visible label - also used for aria-label and as a stable string for tests. */
  label: string;
  /** Optional multi-line render. Defaults to [label]. Use [] to render no visible legend (e.g. spacebar). */
  lines?: string[];
  /** Bound FrontPanelKey if the firmware has a slot for this key. Stubs omit this. */
  binding?: FrontPanelKey;
  variant: KeyVariant;
  /** Override aria-label when the legend is symbolic (e.g. shift caret, cursor scroll). */
  ariaLabel?: string;
  /** Grid column span within the 12-column row. */
  span?: number;
};

const KEYBOARD_ROWS: KeySpec[][] = [
  // Row 1: digits 1-0, DELETE, ACK NAK
  [
    { label: "1", binding: "1", variant: "digit" },
    { label: "2", binding: "2", variant: "digit" },
    { label: "3", binding: "3", variant: "digit" },
    { label: "4", binding: "4", variant: "digit" },
    { label: "5", binding: "5", variant: "digit" },
    { label: "6", binding: "6", variant: "digit" },
    { label: "7", binding: "7", variant: "digit" },
    { label: "8", binding: "8", variant: "digit" },
    { label: "9", binding: "9", variant: "digit" },
    { label: "0", binding: "0", variant: "digit" },
    { label: "DELETE", binding: "DEL", variant: "fn" },
    { label: "ACK NAK", lines: ["ACK", "NAK"], binding: "ACK_NAK", variant: "fn", ariaLabel: "Ack/Nak" }
  ],
  // Row 2: QWERTY top row, DISPL
  [
    { label: "Q", binding: "Q", variant: "letter" },
    { label: "W", binding: "W", variant: "letter" },
    { label: "E", binding: "E", variant: "letter" },
    { label: "R", binding: "R", variant: "letter" },
    { label: "T", binding: "T", variant: "letter" },
    { label: "Y", binding: "Y", variant: "letter" },
    { label: "U", binding: "U", variant: "letter" },
    { label: "I", binding: "I", variant: "letter" },
    { label: "O", binding: "O", variant: "letter" },
    { label: "P", binding: "P", variant: "letter" },
    { label: "DISPL", binding: "DISPL", variant: "fn", span: 2 }
  ],
  // Row 3: home row, =, INPUT PRINT
  [
    { label: "A", binding: "A", variant: "letter" },
    { label: "S", binding: "S", variant: "letter" },
    { label: "D", binding: "D", variant: "letter" },
    { label: "F", binding: "F", variant: "letter" },
    { label: "G", binding: "G", variant: "letter" },
    { label: "H", binding: "H", variant: "letter" },
    { label: "J", binding: "J", variant: "letter" },
    { label: "K", binding: "K", variant: "letter" },
    { label: "L", binding: "L", variant: "letter" },
    { label: "=", binding: "=", variant: "punct" },
    { label: "INPUT PRINT", lines: ["INPUT", "PRINT"], binding: "INPUT_PRINT", variant: "fn", span: 2 }
  ],
  // Row 4: shift, ZXC..., punctuation, ENCR DECR
  [
    { label: "^", binding: "^", variant: "shift", ariaLabel: "Shift" },
    { label: "Z", binding: "Z", variant: "letter" },
    { label: "X", binding: "X", variant: "letter" },
    { label: "C", binding: "C", variant: "letter" },
    { label: "V", binding: "V", variant: "letter" },
    { label: "B", binding: "B", variant: "letter" },
    { label: "N", binding: "N", variant: "letter" },
    { label: "M", binding: "M", variant: "letter" },
    { label: ",", binding: ",", variant: "punct" },
    { label: ".", binding: ".", variant: "punct" },
    { label: "-", binding: "-", variant: "punct" },
    { label: "ENCR DECR", lines: ["ENCR", "DECR"], binding: "ENCR", variant: "fn" }
  ],
  // Row 5: cursor scroll left, spacebar, cursor scroll right, SEND
  [
    { label: "Cursor Scroll Left", lines: ["←|→"], binding: "SCROLL_LEFT", variant: "scroll", ariaLabel: "Cursor scroll left" },
    { label: "SPACE", lines: [], binding: "SPACE", variant: "space", span: 8, ariaLabel: "Space" },
    { label: "Cursor Scroll Right", lines: ["←|→"], binding: "SCROLL_RIGHT", variant: "scroll", ariaLabel: "Cursor scroll right" },
    { label: "SEND", binding: "SEND", variant: "send", span: 2 }
  ]
];

const SIDE_COLUMN_KEYS: KeySpec[] = [
  { label: "ON OFF", lines: ["ON", "OFF"], binding: "ON_OFF", variant: "side" },
  { label: "TIME BRIGHT", lines: ["TIME", "BRIGHT"], binding: "BRIGHT", variant: "side" },
  { label: "NEW KEY", lines: ["NEW", "KEY"], binding: "KEY", variant: "side" },
  { label: "CONF", binding: "CONF", variant: "side" },
  { label: "SHORT TERM", lines: ["SHORT", "TERM"], binding: "SHORT_TERM", variant: "side" }
];

function renderKeys(terminal: "a" | "b"): string {
  const main = KEYBOARD_ROWS.map((row, idx) => {
    const cells = row.map((spec) => renderKey(spec, terminal)).join("");
    return `<div class="key-row keyboard-row-${idx + 1}">${cells}</div>`;
  }).join("");
  const side = SIDE_COLUMN_KEYS.map((spec) => renderKey(spec, terminal)).join("");
  return `
    <div class="keypad">
      <div class="keypad-main" aria-label="Main keypad">${main}</div>
      <div class="fn-column" aria-label="Side function column">${side}</div>
    </div>
  `;
}

function renderKey(spec: KeySpec, terminal: "a" | "b"): string {
  const lines = spec.lines ?? [spec.label];
  const inner = lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
  const isBound = Boolean(spec.binding && BINDABLE_KEYS.has(spec.binding));
  const stubClass = isBound ? "" : " is-stub";
  const variantClass = ` key-${spec.variant}`;
  const dataKeyAttr = isBound ? ` data-key="${escapeHtml(spec.binding ?? "")}" data-terminal="${terminal}"` : "";
  const isDisabled = !isBound || !machineFor(terminal);
  const disabledAttr = isDisabled ? " disabled" : "";
  const ariaLabel = spec.ariaLabel ?? spec.label;
  const span = spec.span ?? 1;
  const styleAttr = span > 1 ? ` style="grid-column: span ${span};"` : "";
  return `<button class="key${variantClass}${stubClass}"${dataKeyAttr}${styleAttr} aria-label="${escapeHtml(ariaLabel)}"${disabledAttr}>${inner}</button>`;
}

function renderDisplay(text: string, brightness = 0): string {
  const cells = text
    .slice(0, 32)
    .padEnd(32, " ")
    .split("")
    .map((char, index) => {
      const isBlank = char === " ";
      const isCursor = index === 31 && char === "?";
      return `<span class="display-cell${isBlank ? " is-blank" : ""}${isCursor ? " is-cursor" : ""}">${escapeHtml(char === " " ? "\u00a0" : char)}</span>`;
    })
    .join("");
  return `<div class="display brightness-${brightness}" aria-label="${escapeHtml(text)}">${cells}</div>`;
}

function renderDisplayDetails(machine: UA8295Machine | null = state.machine): string {
  const lines = machine?.hardware.display.detailLines() ?? ["Display inactive"];
  return lines.map((line) => `<div>${line}</div>`).join("");
}

function renderRomBadges(): string {
  return Object.values(ROM_SPECS)
    .map((spec) => {
      const image = state.roms?.[spec.key];
      const label = image ? `${spec.key}: verified ${image.digest.slice(0, 8)}` : `${spec.key}: missing`;
      return `<span class="rom-badge ${image ? "is-loaded" : "is-missing"}">${escapeHtml(label)}</span>`;
    })
    .join("");
}

function renderOption(value: string, label: string, selected: string): string {
  return `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`;
}

function renderHistogram(entries: Array<[string, number]>): string {
  return entries
    .slice(0, 8)
    .map(([key, count]) => `<li><span>${key}</span><strong>${count.toLocaleString()}</strong></li>`)
    .join("") || "<li>No data yet</li>";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
