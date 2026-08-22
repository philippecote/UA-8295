import { readFileSync } from "node:fs";
import { FRONT_PANEL_KEYS, type FrontPanelKey } from "../src/devices";

export type ManualScenarioStep = {
  press?: FrontPanelKey;
  pressShifted?: FrontPanelKey;
  expectDisplay?: string;
  holdSlices?: number;
  settleSlices?: number;
  advanceSeconds?: number;
  expectBrightness?: 0 | 1 | 2;
  expectBlanked?: boolean;
};

export type ManualScenario = {
  id: string;
  manualSection: string;
  title: string;
  steps: ManualScenarioStep[];
  expectDisplay: string;
  expectedIramByte?: number;
  status?: "pass" | "todo" | "boundary";
  reason?: string;
};

const SCENARIO_PATH = new URL("../docs/manual-tests/section-3-operation.md", import.meta.url);
const SCENARIO_BLOCK = /```ua8295-test\s*\n([\s\S]*?)```/g;
const VALID_KEYS = new Set<string>(FRONT_PANEL_KEYS);

export function loadManualScenarios(): ManualScenario[] {
  const markdown = readFileSync(SCENARIO_PATH, "utf8");
  const scenarios: ManualScenario[] = [];

  for (const match of markdown.matchAll(SCENARIO_BLOCK)) {
    scenarios.push(validateScenario(JSON.parse(match[1])));
  }

  if (scenarios.length === 0) {
    throw new Error(`No ua8295-test blocks found in ${SCENARIO_PATH.pathname}`);
  }

  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate manual scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return scenarios;
}

function validateScenario(value: unknown): ManualScenario {
  if (!value || typeof value !== "object") throw new Error("Manual scenario must be a JSON object");
  const scenario = value as Record<string, unknown>;
  for (const field of ["id", "manualSection", "title", "expectDisplay"] as const) {
    if (typeof scenario[field] !== "string" || scenario[field].length === 0) {
      throw new Error(`Manual scenario has invalid ${field}`);
    }
  }
  if (!Array.isArray(scenario.steps)) throw new Error(`Manual scenario ${scenario.id} has no steps array`);

  for (const [index, valueStep] of scenario.steps.entries()) {
    if (!valueStep || typeof valueStep !== "object") {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} is invalid`);
    }
    const step = valueStep as Record<string, unknown>;
    const hasPress = typeof step.press === "string";
    const hasShiftedPress = typeof step.pressShifted === "string";
    if (hasPress && hasShiftedPress) {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} cannot define both press and pressShifted`);
    }
    if (!hasPress && !hasShiftedPress && step.advanceSeconds === undefined) {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has no action`);
    }
    const key = hasPress ? step.press : step.pressShifted;
    if (key !== undefined && !VALID_KEYS.has(key as string)) {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has unknown key ${String(key)}`);
    }
    if (step.expectDisplay !== undefined && typeof step.expectDisplay !== "string") {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has invalid expectDisplay`);
    }
    if (step.advanceSeconds !== undefined &&
        (typeof step.advanceSeconds !== "number" || !Number.isFinite(step.advanceSeconds) || step.advanceSeconds < 0)) {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has invalid advanceSeconds`);
    }
    if (step.expectBrightness !== undefined && ![0, 1, 2].includes(step.expectBrightness as number)) {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has invalid expectBrightness`);
    }
    if (step.expectBlanked !== undefined && typeof step.expectBlanked !== "boolean") {
      throw new Error(`Manual scenario ${scenario.id} step ${index + 1} has invalid expectBlanked`);
    }
  }

  if (scenario.expectedIramByte !== undefined &&
      (!Number.isInteger(scenario.expectedIramByte) || (scenario.expectedIramByte as number) < 0 || (scenario.expectedIramByte as number) > 0xff)) {
    throw new Error(`Manual scenario ${scenario.id} has invalid expectedIramByte`);
  }
  if (scenario.status !== undefined && !["pass", "todo", "boundary"].includes(scenario.status as string)) {
    throw new Error(`Manual scenario ${scenario.id} has invalid status`);
  }
  if (scenario.status && scenario.status !== "pass" && typeof scenario.reason !== "string") {
    throw new Error(`Manual scenario ${scenario.id} requires a reason for status ${scenario.status}`);
  }
  return scenario as unknown as ManualScenario;
}
