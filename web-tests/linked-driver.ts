import { expect } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { UA8295LinkedPair } from "../src/radio-link";
import { UA8295Machine } from "../src/ua8295";
import { loadTestRomSet } from "./device-driver";

// Two complete terminals joined by the radio link, as used by the manual's
// transmission, reception and acknowledgement procedures.
export type LinkedContext = {
  left: UA8295Machine;
  right: UA8295Machine;
  pair: UA8295LinkedPair;
  run: (slices: number, steps?: number) => void;
  press: (machine: UA8295Machine, key: FrontPanelKey, shifted?: boolean) => void;
};

export async function createLinkedContext(): Promise<LinkedContext> {
  const roms = await loadTestRomSet();
  const left = new UA8295Machine(roms);
  const right = new UA8295Machine(roms);
  left.traceLog.setRecording(false);
  right.traceLog.setRecording(false);
  const pair = new UA8295LinkedPair(left, right);
  const run = (slices: number, steps = 80): void => { pair.runScheduler(slices, steps, false); };
  const press = (machine: UA8295Machine, key: FrontPanelKey, shifted = false): void => {
    if (shifted) machine.hardware.keyboard.setPressed("^", true);
    machine.hardware.keyboard.setPressed(key, true);
    run(250);
    machine.hardware.keyboard.setPressed(key, false);
    if (shifted) machine.hardware.keyboard.setPressed("^", false);
    run(80);
  };

  for (let chunk = 0; chunk < 600; chunk += 1) {
    run(20);
    if (left.hardware.display.displayLine().includes("FUNCTION?") &&
        right.hardware.display.displayLine().includes("FUNCTION?")) break;
  }
  expect(left.hardware.display.displayLine()).toContain("FUNCTION?");
  expect(right.hardware.display.displayLine()).toContain("FUNCTION?");

  for (const machine of [left, right]) {
    press(machine, "CONF", true);
    press(machine, "SHORT_TERM");
  }
  return { left, right, pair, run, press };
}

export function configurePrivateAddress(context: LinkedContext, machine: UA8295Machine, address: string): void {
  context.press(machine, "CONF");
  for (const digit of address) context.press(machine, digit as FrontPanelKey);
  context.press(machine, "=");
  context.press(machine, "SHORT_TERM");
}

export function composeFree(context: LinkedContext, machine: UA8295Machine, text: string): void {
  context.press(machine, "0");
  for (const character of text) context.press(machine, character as FrontPanelKey);
  context.press(machine, "SHORT_TERM");
}

export function sendTo(context: LinkedContext, machine: UA8295Machine, address?: string): void {
  context.press(machine, "SEND");
  if (address) for (const digit of address) context.press(machine, digit as FrontPanelKey);
  context.press(machine, "=");
}

export function waitForAcknowledgement(context: LinkedContext): { sawSenderTx: boolean; sawReceiverTx: boolean } {
  let sawSenderTx = false;
  let sawReceiverTx = false;
  let sawAcknowledged = false;
  for (let chunk = 0; chunk < 20_000; chunk += 1) {
    context.run(10, 40);
    sawSenderTx ||= context.left.hardware.modemRadio.isTransmitting();
    sawReceiverTx ||= context.right.hardware.modemRadio.isTransmitting();
    sawAcknowledged ||= context.left.hardware.display.displayLine().includes("ACKNOWLEDGED");
    if (sawAcknowledged && !context.left.hardware.modemRadio.isTransmitting() &&
        !context.right.hardware.modemRadio.isTransmitting()) break;
  }
  context.run(500, 40);
  expect(sawAcknowledged).toBe(true);
  return { sawSenderTx, sawReceiverTx };
}
