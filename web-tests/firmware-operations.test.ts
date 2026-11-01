import { describe, expect, it } from "vitest";
import { composeFree, configurePrivateAddress, createLinkedContext, sendTo, waitForAcknowledgement } from "./linked-driver";

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

describe("manual section 3.2.13 addressed responses", () => {
  it("transmits manual ACK and NAK packets to the addressed peer UART", async () => {
    const context = await createLinkedContext();
    configurePrivateAddress(context, context.left, "34");
    configurePrivateAddress(context, context.right, "12");

    const transmitResponse = (shifted: boolean, prompt: string): void => {
      const before = context.pair.link.deliveryStats().rightToLeft;
      context.press(context.right, "ACK_NAK", shifted);
      expect(context.right.hardware.display.displayLine()).toContain(prompt);
      context.press(context.right, "3");
      context.press(context.right, "4");
      context.press(context.right, "=");

      let sawTransmit = false;
      for (let chunk = 0; chunk < 8_000; chunk += 1) {
        context.run(10, 40);
        sawTransmit ||= context.right.hardware.modemRadio.isTransmitting();
        const delivered = context.pair.link.deliveryStats().rightToLeft;
        if (sawTransmit && delivered.packets > before.packets &&
            !context.right.hardware.modemRadio.isTransmitting()) break;
      }
      context.run(300, 40);

      const after = context.pair.link.deliveryStats().rightToLeft;
      expect(sawTransmit).toBe(true);
      expect(after.packets).toBe(before.packets + 1);
      expect(after.payloadBytes).toBeGreaterThan(before.payloadBytes);
    };

    transmitResponse(true, "ACK TO STATION:");
    transmitResponse(false, "NAK TO STATION:");
  }, 60_000);
});
