import type { TraceEntry } from "./mcs51";
import type { UA8295Machine } from "./ua8295";

export interface LinkedRunResult {
  left: { main: TraceEntry[]; iop: TraceEntry[] };
  right: { main: TraceEntry[]; iop: TraceEntry[] };
}

export interface RadioDeliveryStats {
  leftToRight: { packets: number; payloadBytes: number };
  rightToLeft: { packets: number; payloadBytes: number };
}

/**
 * A radio channel between two complete UA-8295 terminals. It carries the raw
 * IOP waveform and models the external analog front-end's framing/recovered
 * octets. Both main ROMs still perform encryption, checksums, address filtering,
 * decryption and message storage. Simultaneous transmission drops carrier and
 * recovered bytes at both receivers.
 */
export class UA8295RadioLink {
  collision = false;
  private leftSerialCursor = 0;
  private rightSerialCursor = 0;
  private leftProtocolTxActive = false;
  private rightProtocolTxActive = false;
  private leftProtocolPayloadBytes = 0;
  private rightProtocolPayloadBytes = 0;
  private leftDeliveredPackets = 0;
  private rightDeliveredPackets = 0;
  private leftDeliveredPayloadBytes = 0;
  private rightDeliveredPayloadBytes = 0;

  constructor(
    readonly left: UA8295Machine,
    readonly right: UA8295Machine
  ) {}

  service(): void {
    const leftRadio = this.left.hardware.modemRadio;
    const rightRadio = this.right.hardware.modemRadio;
    const leftTx = leftRadio.isTransmitting();
    const rightTx = rightRadio.isTransmitting();
    const protocolOverlap = this.leftProtocolTxActive && this.rightProtocolTxActive;
    const simultaneousProtocolStart =
      protocolOverlap && this.leftProtocolPayloadBytes === 0 && this.rightProtocolPayloadBytes === 0;
    const directPortOverlap = !this.leftProtocolTxActive && !this.rightProtocolTxActive;
    // An automatic acknowledgement can start while the sender's analog
    // waveform tail is still keyed. Once the sender has emitted its protocol
    // terminator that is a valid turnaround, not a collision. Raw simultaneous
    // port-keying (used by the hardware-level model) remains a collision.
    this.collision = leftTx && rightTx && (simultaneousProtocolStart || directPortOverlap);
    leftRadio.setInput(rightTx && !this.collision, rightRadio.transmitMark());
    rightRadio.setInput(leftTx && !this.collision, leftRadio.transmitMark());
    this.bridgeRecoveredBytes(this.left, this.right, "left");
    this.bridgeRecoveredBytes(this.right, this.left, "right");
  }

  private bridgeRecoveredBytes(source: UA8295Machine, peer: UA8295Machine, side: "left" | "right"): void {
    const transfers = source.hardware.serial.recentTransfers();
    let cursor = side === "left" ? this.leftSerialCursor : this.rightSerialCursor;
    let active = side === "left" ? this.leftProtocolTxActive : this.rightProtocolTxActive;
    let payloadBytes = side === "left" ? this.leftProtocolPayloadBytes : this.rightProtocolPayloadBytes;
    for (const transfer of transfers) {
      if (transfer.sequence <= cursor) continue;
      const startsPacket = transfer.source === "main" && transfer.rb8 && (transfer.value & 0x80) !== 0;
      const peerPayloadBytes = side === "left" ? this.rightProtocolPayloadBytes : this.leftProtocolPayloadBytes;
      // Preserve an automatic ACK in the recovered-byte buffer until the
      // original sender has physically released transmit. Real modem
      // turnaround supplies this guard time; without it the carrier edge can
      // reach the sender ROM while it is still switching to receive mode.
      if (startsPacket && peer.hardware.modemRadio.isTransmitting() && peerPayloadBytes > 0) break;
      cursor = transfer.sequence;
      // The real modem's carrier/framing detector reports 0x40 to the main
      // CPU before received payload bytes. The analog detector is outside the
      // ROMs; synthesize that edge when the peer accepts a transmit command
      // (0x8x), then deliver the front-end's recovered encrypted octets below.
      if (startsPacket) {
        active = true;
        payloadBytes = 0;
        if (!this.collision) {
          peer.mainCpu.receiveSerial(0x40, true);
          if (side === "left") this.leftDeliveredPackets += 1;
          else this.rightDeliveredPackets += 1;
        }
      } else if (active && transfer.source === "main" && transfer.rb8) {
        // The main CPU closes a modem transaction with an unshifted control
        // command (normally 0x02, followed by 0x01).
        active = false;
      } else if (active && transfer.source === "main" && !transfer.rb8 && transfer.value === 0xff) {
        // 0xFF is the modem packet terminator, not part of the recovered
        // encrypted payload presented to the peer main CPU.
        active = false;
      } else if (active && transfer.source === "main" && !transfer.rb8 && !this.collision) {
        // The demodulator returns the encrypted over-the-air octets unchanged;
        // forward that recovered byte into the peer's existing main/IOP serial
        // receive path. Framing, checksum, decryption, address filtering and
        // message storage remain original main-ROM behavior.
        peer.mainCpu.receiveSerial(transfer.value, false);
        payloadBytes += 1;
        if (side === "left") this.leftDeliveredPayloadBytes += 1;
        else this.rightDeliveredPayloadBytes += 1;
      }
    }
    if (side === "left") {
      this.leftSerialCursor = cursor;
      this.leftProtocolTxActive = active;
      this.leftProtocolPayloadBytes = payloadBytes;
    } else {
      this.rightSerialCursor = cursor;
      this.rightProtocolTxActive = active;
      this.rightProtocolPayloadBytes = payloadBytes;
    }
  }

  status(): string {
    if (this.collision) return "collision";
    if (this.left.hardware.modemRadio.isTransmitting()) return "terminal A transmitting";
    if (this.right.hardware.modemRadio.isTransmitting()) return "terminal B transmitting";
    return "connected";
  }

  deliveryStats(): RadioDeliveryStats {
    return {
      leftToRight: {
        packets: this.leftDeliveredPackets,
        payloadBytes: this.leftDeliveredPayloadBytes
      },
      rightToLeft: {
        packets: this.rightDeliveredPackets,
        payloadBytes: this.rightDeliveredPayloadBytes
      }
    };
  }
}

export class UA8295LinkedPair {
  readonly link: UA8295RadioLink;

  constructor(
    readonly left: UA8295Machine,
    readonly right: UA8295Machine
  ) {
    this.link = new UA8295RadioLink(left, right);
  }

  runScheduler(slices: number, stepsPerCpu = 1, trace = false): LinkedRunResult {
    const result: LinkedRunResult = {
      left: { main: [], iop: [] },
      right: { main: [], iop: [] }
    };
    for (let slice = 0; slice < slices; slice += 1) {
      this.link.service();
      // Bit-level interleaving is required only while the modem waveform is
      // active. Boot and normal UI work retain the faster chunked scheduler.
      const transmitting =
        this.left.hardware.modemRadio.isTransmitting() ||
        this.right.hardware.modemRadio.isTransmitting();
      if (transmitting) {
        // The modem timers run from CPU cycles, not instruction count.  The
        // transmitter and receiver execute different instruction paths, so
        // alternating one instruction per terminal steadily skews their
        // clocks and destroys the AFSK sampling window. Keep both IOP clocks
        // on the same simulated timeline while servicing the wire after every
        // instruction/transition.
        for (let step = 0; step < stepsPerCpu; step += 1) {
          this.left.hardware.service();
          this.right.hardware.service();
          this.appendMain(result.left, this.left.runCpu("main", 1, trace));
          this.link.service();
          this.appendMain(result.right, this.right.runCpu("main", 1, trace));
          this.link.service();
          for (let iopStep = 0; iopStep < 2; iopStep += 1) {
            if (this.left.iopCpu.cycles <= this.right.iopCpu.cycles) {
              this.appendIop(result.left, this.left.runCpu("iop", 1, trace));
            } else {
              this.appendIop(result.right, this.right.runCpu("iop", 1, trace));
            }
            this.link.service();
          }
        }
      } else {
        this.append(result.left, this.left.runScheduler(1, stepsPerCpu, trace));
        this.link.service();
        this.append(result.right, this.right.runScheduler(1, stepsPerCpu, trace));
        this.link.service();
      }
    }
    return result;
  }

  private append(target: { main: TraceEntry[]; iop: TraceEntry[] }, source: { main: TraceEntry[]; iop: TraceEntry[] }): void {
    if (source.main.length) target.main.push(...source.main);
    if (source.iop.length) target.iop.push(...source.iop);
  }

  private appendMain(target: { main: TraceEntry[]; iop: TraceEntry[] }, entries: TraceEntry[]): void {
    if (entries.length) target.main.push(...entries);
  }

  private appendIop(target: { main: TraceEntry[]; iop: TraceEntry[] }, entries: TraceEntry[]): void {
    if (entries.length) target.iop.push(...entries);
  }
}
