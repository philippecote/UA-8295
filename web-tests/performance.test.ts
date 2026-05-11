import { describe, expect, it } from "vitest";
import { HeadlessDeviceDriver } from "./device-driver";

const BOOT_BUDGET_MS = 15_000;
const SCHEDULER_BUDGET_MS = 2_500;

describe("emulator performance budgets", () => {
  it("boots the real ROMs within the headless budget", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    const start = performance.now();

    driver.runCoupledBoot();

    expect(performance.now() - start).toBeLessThan(BOOT_BUDGET_MS);
    expect(driver.displayText()).toContain("FUNCTION?");
  }, 20_000);

  it("keeps continuous scheduler frames under the responsiveness budget", async () => {
    const driver = await HeadlessDeviceDriver.create({ traceAllXdata: false });
    const start = performance.now();

    driver.runSchedulerSlices(400, 80);

    expect(performance.now() - start).toBeLessThan(SCHEDULER_BUDGET_MS);
  });
});
