import { describe, expect, it } from "vitest";
import { HeadlessDeviceDriver } from "./device-driver";
import { loadManualScenarios } from "./manual-scenarios";

const manualScenarios = loadManualScenarios();
const runnableScenarios = manualScenarios.filter((scenario) => !scenario.status || scenario.status === "pass");
const pendingScenarios = manualScenarios.filter((scenario) => scenario.status === "todo" || scenario.status === "boundary");

describe("manual-grounded acceptance suite", () => {
  it.each(runnableScenarios)("$manualSection $title", async (testCase) => {
    const driver = await HeadlessDeviceDriver.create({ maxTraceEvents: 80_000, traceAllXdata: true });
    driver.runCoupledBoot();

    for (const step of testCase.steps) {
      const key = step.press ?? step.pressShifted;
      if (key) {
        if (step.pressShifted) driver.pressKey("^");
        if (step.expectDisplay) {
          driver.pressAndWaitForDisplay(key, step.expectDisplay, {
            holdSlices: step.holdSlices,
            settleSlices: step.settleSlices
          });
        } else {
          driver.pressKey(key);
          driver.runSchedulerSlices(step.holdSlices ?? 250);
          driver.releaseKey(key);
          driver.runSchedulerSlices(step.settleSlices ?? 80);
        }
        if (step.pressShifted) {
          driver.releaseKey("^");
          driver.runSchedulerSlices(step.settleSlices ?? 80);
        }
      }
      if (step.advanceSeconds) driver.machine.hardware.advanceSeconds(step.advanceSeconds);
      if (step.expectBrightness !== undefined) {
        expect(driver.machine.hardware.display.brightnessLevel(), `brightness for ${testCase.id}`).toBe(step.expectBrightness);
      }
      if (step.expectBlanked !== undefined) {
        expect(driver.machine.hardware.display.isBlanked(), `blanking for ${testCase.id}`).toBe(step.expectBlanked);
      }
    }

    const display = driver.displayText();
    const history = driver.displayHistory();
    const diagnostics = {
      display,
      history: history.slice(-8),
      summary: driver.summary()
    };

    // The display ISR can repaint cells immediately after a prompt is rendered,
    // so assert that the expected state was observed during the workflow.
    expect(
      history.some((line) => line.includes(testCase.expectDisplay)),
      JSON.stringify(diagnostics)
    ).toBe(true);

    if (testCase.expectedIramByte !== undefined) {
      expect(driver.machine.mainCpu.iram[0x1c], `iram[0x1C] for ${testCase.id}`).toBe(testCase.expectedIramByte);
    }
  }, 45_000);

  for (const scenario of pendingScenarios) {
    it.todo(`${scenario.manualSection} ${scenario.title} [${scenario.status}: ${scenario.reason}]`);
  }
});
