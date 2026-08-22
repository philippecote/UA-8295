import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { UA8295LinkedPair } from "../src/radio-link";
import { UA8295Machine } from "../src/ua8295";
import { loadTestRomSet } from "./device-driver";

type LinkedContext = {
  left: UA8295Machine;
  right: UA8295Machine;
  pair: UA8295LinkedPair;
  run: (slices: number, steps?: number) => void;
  press: (machine: UA8295Machine, key: FrontPanelKey, shifted?: boolean) => void;
};

async function createLinkedContext(): Promise<LinkedContext> {
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

function configurePrivateAddress(context: LinkedContext, machine: UA8295Machine, address: string): void {
  context.press(machine, "CONF");
  for (const digit of address) context.press(machine, digit as FrontPanelKey);
  context.press(machine, "=");
  context.press(machine, "SHORT_TERM");
}

function composeFree(context: LinkedContext, machine: UA8295Machine, text: string): void {
  context.press(machine, "0");
  for (const character of text) context.press(machine, character as FrontPanelKey);
  context.press(machine, "SHORT_TERM");
}

function sendTo(context: LinkedContext, machine: UA8295Machine, address?: string): void {
  context.press(machine, "SEND");
  if (address) for (const digit of address) context.press(machine, digit as FrontPanelKey);
  context.press(machine, "=");
}

function waitForAcknowledgement(context: LinkedContext): { sawSenderTx: boolean; sawReceiverTx: boolean } {
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

describe("manual sections 3.2.8-3.2.10 linked operations", () => {
  it("transmits both small and large memories with automatic ACK, iteration, indicators, and deletion", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");

    composeFree(context, context.left, "LG");
    context.press(context.left, "SHORT_TERM", true);
    composeFree(context, context.left, "SM");

    context.press(context.left, "SHORT_TERM", true);
    sendTo(context, context.left, "12");
    const first = waitForAcknowledgement(context);
    expect(first.sawSenderTx).toBe(true);
    expect(first.sawReceiverTx).toBe(true);
    expect(context.left.hardware.display.displayLine()).toContain("ACKNOWLEDGED");
    expect(context.right.receiveMessageIndicatorLit()).toBe(true);

    // Large memory is the default for the next transmission; the old receiver
    // address is retained and accepted without retyping it.
    sendTo(context, context.left);
    waitForAcknowledgement(context);
    expect(context.right.receiveMessageIndicatorLit()).toBe(true);

    context.press(context.right, "DISPL");
    expect(context.right.hardware.display.displayLine()).toContain("MESSAGE 1...2?");
    context.press(context.right, "1");
    expect(context.right.hardware.display.displayLine()).toContain("SENDER,TIME: 34");
    context.press(context.right, "SCROLL_LEFT");
    expect(context.right.hardware.display.displayLine().trim()).toBe("SM");
    expect(context.right.receiveMessageIndicatorLit()).toBe(true);

    context.press(context.right, "DISPL");
    expect(context.right.hardware.display.displayLine()).toContain("MSG2 SENDER,TIME: 34");
    context.press(context.right, "SCROLL_LEFT");
    expect(context.right.hardware.display.displayLine().trim()).toBe("LG");
    expect(context.right.receiveMessageIndicatorLit()).toBe(false);

    context.press(context.right, "DEL", true);
    context.press(context.right, "SHORT_TERM");
    context.press(context.right, "DISPL");
    expect(context.right.hardware.display.displayLine()).toContain("MESSAGE 1...1?");
  }, 90_000);

  it("rejects a message addressed to a different terminal", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    composeFree(context, context.left, "NO");
    sendTo(context, context.left, "13");

    let sawSenderTx = false;
    let sawReceiverTx = false;
    for (let chunk = 0; chunk < 8_000; chunk += 1) {
      context.run(10, 40);
      sawSenderTx ||= context.left.hardware.modemRadio.isTransmitting();
      sawReceiverTx ||= context.right.hardware.modemRadio.isTransmitting();
      if (sawSenderTx && !context.left.hardware.modemRadio.isTransmitting() && chunk > 2_000) break;
    }
    context.run(500, 40);

    expect(sawSenderTx).toBe(true);
    expect(sawReceiverTx).toBe(false);
    expect(context.right.receiveMessageIndicatorLit()).toBe(false);
    expect([...context.right.mainBus.xram.slice(0, 0x20)]).toEqual(new Array(0x20).fill(0));
  }, 60_000);

});
