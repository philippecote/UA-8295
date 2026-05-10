import "./styles.css";
import { FRONT_PANEL_KEYS, type FrontPanelKey } from "./devices";
import { hex } from "./memory";
import { formatTrace, type TraceEntry } from "./mcs51";
import { loadBundledRomSet, loadRomSetFromFiles, ROM_SPECS, type RomSet } from "./roms";
import { UA8295Machine } from "./ua8295";
import { formatTraceEvent, summarizeTraceEvents, type CpuName, type TraceEventKind } from "./trace";

const state: {
  roms: RomSet | null;
  machine: UA8295Machine | null;
  activeCpu: CpuName;
  trace: TraceEntry[];
  ioCpuFilter: CpuName | "device" | "all";
  ioKindFilter: TraceEventKind | "all";
  traceAllXdata: boolean;
  continuousRun: boolean;
  status: string;
} = {
  roms: null,
  machine: null,
  activeCpu: "main",
  trace: [],
  ioCpuFilter: "all",
  ioKindFilter: "all",
  traceAllXdata: false,
  continuousRun: false,
  status: "Load ROMs to start."
};

const appElement = document.querySelector<HTMLElement>("#app");
if (!appElement) {
  throw new Error("Missing #app root");
}
const app = appElement;
let animationHandle: number | null = null;

render();

function render(): void {
  const cpu = state.machine?.cpu(state.activeCpu);
  const snapshot = cpu?.snapshot();
  const displayText = state.machine?.hardware.display.displayLine();
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
    <section class="hero">
      <div>
        <p class="eyebrow">Philips UA-8295 / Nokia DA-8520</p>
        <h1>Browser ROM Emulator</h1>
        <p>This is the browser-native TypeScript port of the 80C31 emulator. It executes the public EPROM images locally and exposes CPU state while the device peripherals are reverse engineered.</p>
      </div>
      <div class="device">
        <div class="display">${displayText ?? displayLine(snapshot)}</div>
        <div class="keyboard">${renderKeys()}</div>
        <div class="keyboard-status">${state.machine?.hardware.keyboard.describe() ?? "Keyboard inactive"}</div>
        <div class="display-details">${renderDisplayDetails()}</div>
      </div>
    </section>

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
    if (!key) return;
    button.addEventListener("pointerdown", () => setKey(key, true));
    button.addEventListener("pointerup", () => setKey(key, false));
    button.addEventListener("pointerleave", () => setKey(key, false));
    button.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") setKey(key, true);
    });
    button.addEventListener("keyup", () => setKey(key, false));
  });
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
  state.trace = [];
  state.status = status;
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

function runFrame(): void {
  const machine = state.machine;
  if (!machine) return;
  try {
    const result = machine.runScheduler(60, 4, true);
    appendInstructionTrace([...result.main, ...result.iop]);
    state.status = "Ran one scheduler frame.";
  } catch (error) {
    stopContinuousRun();
    state.status = `CPU stopped: ${error instanceof Error ? error.message : String(error)}`;
  }
  render();
}

function toggleContinuousRun(): void {
  if (state.continuousRun) {
    stopContinuousRun();
    state.status = "Continuous run paused.";
    render();
    return;
  }
  state.continuousRun = true;
  state.status = "Continuous run active.";
  scheduleContinuousRun();
  render();
}

function scheduleContinuousRun(): void {
  if (!state.continuousRun) return;
  animationHandle = requestAnimationFrame(() => {
    runFrame();
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

function setKey(key: FrontPanelKey, isPressed: boolean): void {
  const machine = state.machine;
  if (!machine) return;
  machine.hardware.keyboard.setPressed(key, isPressed);
  state.status = isPressed ? `Pressed ${key}.` : `Released ${key}.`;
  render();
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

function renderKeys(): string {
  return FRONT_PANEL_KEYS.map((key) => `<button data-key="${key}" ${state.machine ? "" : "disabled"}>${key}</button>`).join("");
}

function renderDisplayDetails(): string {
  const lines = state.machine?.hardware.display.detailLines() ?? ["Display inactive"];
  return lines.map((line) => `<div>${line}</div>`).join("");
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
