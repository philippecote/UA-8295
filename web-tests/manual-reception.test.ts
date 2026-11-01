import { describe, expect, it } from "vitest";
import type { FrontPanelKey } from "../src/devices";
import type { UA8295Machine } from "../src/ua8295";
import { composeFree, configurePrivateAddress, createLinkedContext, sendTo, type LinkedContext } from "./linked-driver";

function setTime(context: LinkedContext, machine: UA8295Machine, time: string): void {
  context.press(machine, "BRIGHT", true);
  for (const digit of time) context.press(machine, digit as FrontPanelKey);
  context.press(machine, "=");
}

/** Wait until terminal A's next packet has been delivered and both radios are idle. */
function waitForDelivery(context: LinkedContext): void {
  const before = context.pair.link.deliveryStats().leftToRight.packets;
  for (let chunk = 0; chunk < 20_000; chunk += 1) {
    context.run(10, 40);
    if (context.pair.link.deliveryStats().leftToRight.packets > before &&
        !context.left.hardware.modemRadio.isTransmitting() &&
        !context.right.hardware.modemRadio.isTransmitting()) break;
  }
  context.run(3_000, 40);
}

/** Received-message records start at SRAM 0x6001; each ends with 0xFE. */
function receivedRecords(machine: UA8295Machine): number[][] {
  const records: number[][] = [];
  let offset = 1;
  while (offset < 0x0800 && machine.mainBus.xram[offset] !== 0xff) {
    const end = machine.mainBus.xram.indexOf(0xfe, offset);
    records.push([...machine.mainBus.xram.slice(offset, end + 1)]);
    offset = end + 1;
  }
  return records;
}

describe("manual section 3.2.9 reception", () => {
  it("flags a clock error, withholds the automatic ACK and sounds the alarm until a key is pressed", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    context.press(context.right, "CONF");
    for (let page = 0; page < 6; page += 1) context.press(context.right, "=");
    expect(context.right.hardware.display.displayLine()).toContain("SOUND ALARM ON");
    context.press(context.right, "SHORT_TERM");

    // More than five minutes apart: the time check fails (paragraphs 2.10, 3.6).
    setTime(context, context.left, "1200");
    setTime(context, context.right, "1210");
    composeFree(context, context.left, "HI");
    sendTo(context, context.left, "12");
    waitForDelivery(context);

    expect(context.left.hardware.display.displayLine()).toContain("SENT");
    expect(context.left.hardware.display.displayLine()).not.toContain("ACKNOWLEDGED");
    expect(context.pair.link.deliveryStats().rightToLeft.packets).toBe(0);
    expect(context.right.receiveMessageIndicatorLit()).toBe(true);

    const buzzer = context.right.hardware.buzzer;
    expect(buzzer.isSounding(context.right.mainCpu.cycles)).toBe(true);
    context.press(context.right, "SPACE");
    context.run(2_000);
    expect(buzzer.isSounding(context.right.mainCpu.cycles)).toBe(false);

    context.press(context.right, "DISPL");
    context.press(context.right, "1");
    expect(context.right.hardware.display.displayLine()).toContain("MSG1 SENDER,TIME: 34 1200 CE");
    context.press(context.right, "SCROLL_LEFT");
    expect(context.right.hardware.display.displayLine().trim()).toBe("HI");
  }, 180_000);

  it("corrects isolated bit errors, flags uncorrectable data errors and rejects a garbled burst", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");
    composeFree(context, context.left, "HI");

    context.pair.link.noise.leftToRight.set(10, 0x01);
    sendTo(context, context.left, "12");
    waitForDelivery(context);
    expect(context.left.hardware.display.displayLine()).toContain("ACKNOWLEDGED");
    expect(receivedRecords(context.right)).toHaveLength(1);
    expect(receivedRecords(context.right)[0].slice(-3)).toEqual([0x08, 0x09, 0xfe]);

    // Errors beyond the BCH code's reach in the message body: stored, marked DE.
    context.pair.link.noise.leftToRight.clear();
    for (let byte = 12; byte < 16; byte += 1) context.pair.link.noise.leftToRight.set(byte, 0xff);
    sendTo(context, context.left);
    waitForDelivery(context);
    const records = receivedRecords(context.right);
    expect(records).toHaveLength(2);
    expect(records[1][1] & 0x01).toBe(0x01);
    context.press(context.right, "DISPL");
    context.press(context.right, "2");
    expect(context.right.hardware.display.displayLine()).toMatch(/MSG2 SENDER,TIME: 34 \d{4}\s+DE/);
    context.press(context.right, "SHORT_TERM");

    // Paragraph 3.4: the receiver synchronises but reception does not succeed.
    context.pair.link.noise.leftToRight.clear();
    for (let byte = 4; byte < 30; byte += 1) context.pair.link.noise.leftToRight.set(byte, 0x5a);
    sendTo(context, context.left);
    waitForDelivery(context);
    expect(context.left.hardware.display.displayLine()).not.toContain("ACKNOWLEDGED");
    expect(receivedRecords(context.right)).toHaveLength(2);
  }, 300_000);

  it("reports RECEIVING MEMORY FULL after the eighth message and rejects a ninth", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");

    // Seven previously received (and read) messages in battery-backed SRAM.
    const record = [0x26, 0x04, 0x33, 0x34, 0x30, 0x30, 0x30, 0x30, 0x0f, 0x0c, 0x04, 0xfe];
    const seeded = Array.from({ length: 7 }, () => record).flat();
    context.right.mainBus.xram.set(seeded, 1);
    context.right.mainBus.xram[1 + seeded.length] = 0xff;
    expect(receivedRecords(context.right)).toHaveLength(7);

    composeFree(context, context.left, "HI");
    sendTo(context, context.left, "12");
    waitForDelivery(context);
    expect(receivedRecords(context.right)).toHaveLength(8);
    // The receiver resumes its previous function; paragraph 3.4 has the
    // operator confirm with TERM to see the error message.
    context.press(context.right, "SHORT_TERM");
    expect(context.right.hardware.display.displayLine()).toContain("RECEIVING MEMORY FULL");

    sendTo(context, context.left);
    waitForDelivery(context);
    expect(receivedRecords(context.right)).toHaveLength(8);
    expect(context.left.hardware.display.displayLine()).not.toContain("ACKNOWLEDGED");
  }, 240_000);
});
