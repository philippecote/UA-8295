import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import { decodeSerialSettings } from "../src/serial-port";
import type { UA8295Machine } from "../src/ua8295";
import { composeFree, configurePrivateAddress, createLinkedContext, sendTo, type LinkedContext } from "./linked-driver";

/** Run until a radio exchange has started and both radios have stayed idle. */
function settle(context: LinkedContext): void {
  const transmitting = () =>
    context.left.hardware.modemRadio.isTransmitting() || context.right.hardware.modemRadio.isTransmitting();
  let seen = false;
  for (let chunk = 0; chunk < 20_000; chunk += 1) {
    context.run(10, 40);
    seen ||= transmitting();
    if (seen && !transmitting() && chunk > 50) {
      context.run(3_000, 40);
      if (!transmitting()) return;
    }
  }
}

function storedMessages(machine: UA8295Machine): number {
  let count = 0;
  for (let offset = 1; offset < 0x0800 && machine.mainBus.xram[offset] !== 0xff; offset += 1) {
    if (machine.mainBus.xram[offset] === 0xfe) count += 1;
  }
  return count;
}

function useDaysKey(context: LinkedContext, machine: UA8295Machine, keyword: string): void {
  context.press(machine, "CONF");
  for (let page = 0; page < 4; page += 1) context.press(machine, "=");
  context.press(machine, "DEL");
  expect(machine.hardware.display.displayLine()).toContain("DAY'S KEY");
  context.press(machine, "SHORT_TERM");
  context.press(machine, "KEY", true);
  pressAll(context, machine, [...keyword] as FrontPanelKey[]);
  context.press(machine, "=");
  context.run(1_200);
}

function keyId(context: LinkedContext, machine: UA8295Machine): string {
  context.press(machine, "KEY");
  const id = /KEY: (\w{4})/.exec(machine.hardware.display.displayLine())?.[1] ?? "";
  context.press(machine, "SHORT_TERM");
  return id;
}

function pressAll(context: LinkedContext, machine: UA8295Machine, keys: readonly FrontPanelKey[]): void {
  for (const key of keys) context.press(machine, key);
}

describe("manual sections 3.2.10 and 3.2.13 responses between terminals", () => {
  it("prints a received fixed-format message and returns a late manual ACK to its sender", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");

    // Terminal B: no automatic acknowledgement, automatic printing of received messages.
    context.press(context.right, "CONF");
    for (let page = 0; page < 5; page += 1) context.press(context.right, "=");
    context.press(context.right, "DEL");
    expect(context.right.hardware.display.displayLine()).toContain("NO AUTOACKNOWLEDGEMENT");
    for (let page = 0; page < 4; page += 1) context.press(context.right, "=");
    while (!/PRINTER:REC {2}/.test(context.right.hardware.display.displayLine())) context.press(context.right, "DEL");
    context.press(context.right, "SHORT_TERM");
    context.right.hardware.printer.settings = decodeSerialSettings(context.right.mainBus.xram[0x130e]);

    // Fixed format 1 with an "OK" free-format tail.
    pressAll(context, context.left, ["1", "1", "2", "3", "4", "=", "5", "6", "7", "8", "=", "9", "0", "=", "1", "2", "3", "=", "O", "K", "SHORT_TERM"]);
    sendTo(context, context.left, "12");
    settle(context);
    expect(context.left.hardware.display.displayLine()).toContain("SENT");
    expect(context.left.hardware.display.displayLine()).not.toContain("ACKNOWLEDGED");
    expect(storedMessages(context.right)).toBe(1);

    context.press(context.right, "DISPL");
    context.press(context.right, "1");
    expect(context.right.hardware.display.displayLine()).toContain("(PRINTING)");
    for (let chunk = 0; chunk < 400; chunk += 1) context.run(100, 80);
    expect(context.right.hardware.printer.transcript()).toBe(
      "\nRECEIVED FROM STATION, TIME:34 0000\n\n\nCOORDINATES X:1234\n Y:5678\n BEARING:90''\n RANGE:123'\nOK.\n"
    );
    context.press(context.right, "SHORT_TERM");

    // Paragraph 2.13: ACK addressed to the original sender, which stores it
    // as an acknowledgement entry and lights MESSAGE.
    context.press(context.right, "ACK_NAK", true);
    pressAll(context, context.right, ["3", "4", "="]);
    settle(context);
    expect(context.left.receiveMessageIndicatorLit()).toBe(true);
    expect(context.left.mainBus.xram[2] & 0x20).toBe(0x20);
    context.press(context.left, "SHORT_TERM");
    context.press(context.left, "DISPL");
    context.press(context.left, "1");
    expect(context.left.hardware.display.displayLine()).toContain("ACK1 SENDER,TIME: 12");
  }, 600_000);
});

describe("manual sections 3.3.3-3.3.6 reception and acknowledgement faults", () => {
  it("withholds ACKs for broadcasts, rejects a different key and gets no answer from a switched-off receiver", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    composeFree(context, context.left, "HI");

    // 3.6: broadcast address 00 is received but never acknowledged.
    sendTo(context, context.left, "00");
    settle(context);
    expect(storedMessages(context.right)).toBe(1);
    expect(context.pair.link.deliveryStats().rightToLeft.packets).toBe(0);
    expect(context.left.hardware.display.displayLine()).not.toContain("ACKNOWLEDGED");

    // 3.4: both stations use day's keys, but with different keywords, so
    // reception does not succeed. (A fixed-key message is still readable:
    // the manual's remedy is to fall back to the fixed key.)
    useDaysKey(context, context.left, "ALPHA");
    useDaysKey(context, context.right, "BRAVO");
    expect(keyId(context, context.left)).not.toBe(keyId(context, context.right));
    sendTo(context, context.left, "12");
    settle(context);
    expect(storedMessages(context.right)).toBe(1);
    expect(context.pair.link.deliveryStats().rightToLeft.packets).toBe(0);

    // 3.3 / 3.5: a receiver that is switched off never answers.
    context.right.setPowered(false);
    const delivered = context.pair.link.deliveryStats().leftToRight.packets;
    sendTo(context, context.left, "12");
    settle(context);
    expect(context.pair.link.deliveryStats().leftToRight.packets).toBe(delivered + 1);
    expect(context.left.hardware.display.displayLine()).toContain("SENT");
    expect(context.pair.link.deliveryStats().rightToLeft.packets).toBe(0);
    context.right.setPowered(true);
    context.run(4_000);
    expect(storedMessages(context.right)).toBe(1);
  }, 600_000);

  it("stores nothing and sends no ACK when the transmission is cut off mid-message", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    composeFree(context, context.left, "HELLO WORLD");

    // 3.7: the radio path fails after the first few recovered octets.
    sendTo(context, context.left, "12");
    for (let chunk = 0; chunk < 20_000 && context.pair.link.deliveryStats().leftToRight.payloadBytes < 6; chunk += 1) context.run(10, 40);
    context.pair.link.connected = false;
    settle(context);
    expect(storedMessages(context.right)).toBe(0);
    expect(context.left.hardware.display.displayLine()).toContain("SENT");
    expect(context.pair.link.deliveryStats().rightToLeft.packets).toBe(0);
  }, 600_000);
});
