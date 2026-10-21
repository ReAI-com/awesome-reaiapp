/** 基于 RFB 的 DisplayInput：macOS 客体走 Virtualization.framework 内置 VNC。 */
import type { ModifierMap } from "./keys";
import { RfbClient } from "./rfb/client";
import type { DisplayCapabilities, DisplayEndpoint, DisplayInput, Frame } from "./types";

export class RfbDisplayInput implements DisplayInput {
  private constructor(
    private readonly client: RfbClient,
    readonly capabilities: DisplayCapabilities,
    readonly modifiers: ModifierMap,
  ) {}

  static async connect(
    endpoint: DisplayEndpoint,
    capabilities: DisplayCapabilities,
    modifiers: ModifierMap,
  ): Promise<RfbDisplayInput> {
    const client = await RfbClient.connect({ ...endpoint, timeoutMs: 15_000 });
    return new RfbDisplayInput(client, capabilities, modifiers);
  }

  get width() {
    return this.client.width;
  }

  get height() {
    return this.client.height;
  }

  get closed() {
    return this.client.isClosed;
  }

  capture(): Promise<Frame> {
    return this.client.captureFrame();
  }

  pointer(x: number, y: number, buttonMask: number) {
    this.client.pointer(x, y, buttonMask);
  }

  key(keysym: number, down: boolean) {
    this.client.key(keysym, down);
  }

  close() {
    this.client.close();
  }
}
