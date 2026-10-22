/**
 * 测试用假 RFB 服务端：按 RFC 6143 应答握手，记录客户端发来的输入事件，
 * 收到画面请求时回一张 Raw 编码的整屏画面。只监听回环地址。
 */
import { createServer, type Server, type Socket } from "node:net";
import { vncAuthResponse } from "../src/rfb/des";

export type ClientEvent =
  | { type: "pointer"; x: number; y: number; mask: number }
  | { type: "key"; keysym: number; down: boolean };

export interface FakeServerOptions {
  version?: string;
  password?: string;
  width?: number;
  height?: number;
  /** 每个像素的 RGB，默认按坐标生成渐变。 */
  pixel?: (x: number, y: number) => [number, number, number];
}

export class FakeRfbServer {
  events: ClientEvent[] = [];
  frameRequests = 0;
  connections = 0;
  width: number;
  height: number;
  private server: Server;
  private sockets = new Set<Socket>();
  private pendingResize: { width: number; height: number } | null = null;

  private constructor(private readonly options: FakeServerOptions) {
    this.width = options.width ?? 64;
    this.height = options.height ?? 48;
    this.server = createServer((socket) => this.handle(socket));
  }

  static async start(options: FakeServerOptions = {}): Promise<FakeRfbServer> {
    const fake = new FakeRfbServer(options);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("未监听");
    return address.port;
  }

  /** 不再回应画面请求（模拟客体显示休眠）。 */
  silent = false;
  /** 回应画面请求前的延迟（模拟抓取耗时）。 */
  frameDelayMs = 0;

  /** 下一次画面请求时通知客户端分辨率变化。 */
  resize(width: number, height: number) {
    this.pendingResize = { width, height };
  }

  dropConnections() {
    for (const socket of this.sockets) socket.destroy();
  }

  async stop() {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(socket: Socket) {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let stage: "version" | "security" | "auth" | "init" | "messages" = "version";
    let clientMinor = 8;
    const challenge = Buffer.alloc(16, 0x5a);
    const minorOf = (v: string) => Number(v.slice(8, 11));

    socket.write(this.options.version ?? "RFB 003.008\n");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === "version") {
          if (buffer.length < 12) return;
          const minor = minorOf(buffer.subarray(0, 12).toString("latin1"));
          clientMinor = minor;
          buffer = buffer.subarray(12);
          if (minor === 3) {
            const type = this.options.password === undefined ? 1 : 2;
            const head = Buffer.alloc(4);
            head.writeUInt32BE(type);
            socket.write(head);
            if (type === 2) {
              socket.write(challenge);
              stage = "auth";
            } else stage = "init";
          } else {
            socket.write(Buffer.from([1, this.options.password === undefined ? 1 : 2]));
            stage = "security";
          }
          continue;
        }
        if (stage === "security") {
          if (buffer.length < 1) return;
          const chosen = buffer[0]!;
          buffer = buffer.subarray(1);
          if (chosen === 2) {
            socket.write(challenge);
            stage = "auth";
          } else {
            // 3.7 下 None 没有 SecurityResult，3.8 才有。
            if (clientMinor >= 8) socket.write(Buffer.alloc(4));
            stage = "init";
          }
          continue;
        }
        if (stage === "auth") {
          if (buffer.length < 16) return;
          const answer = buffer.subarray(0, 16);
          buffer = buffer.subarray(16);
          const ok = Buffer.from(vncAuthResponse(this.options.password ?? "", challenge)).equals(answer);
          const result = Buffer.alloc(4);
          result.writeUInt32BE(ok ? 0 : 1);
          socket.write(result);
          if (!ok) {
            const reason = Buffer.from("bad password");
            const length = Buffer.alloc(4);
            length.writeUInt32BE(reason.length);
            socket.write(Buffer.concat([length, reason]));
            socket.end();
            return;
          }
          stage = "init";
          continue;
        }
        if (stage === "init") {
          if (buffer.length < 1) return;
          buffer = buffer.subarray(1);
          const name = Buffer.from("fake");
          const init = Buffer.alloc(24);
          init.writeUInt16BE(this.width, 0);
          init.writeUInt16BE(this.height, 2);
          init.writeUInt32BE(name.length, 20);
          socket.write(Buffer.concat([init, name]));
          stage = "messages";
          continue;
        }
        const consumed = this.handleMessage(socket, buffer);
        if (consumed === 0) return;
        buffer = buffer.subarray(consumed);
      }
    });
  }

  /** 返回消耗的字节数，数据不够时返回 0。 */
  private handleMessage(socket: Socket, buffer: Buffer): number {
    if (buffer.length < 1) return 0;
    switch (buffer[0]) {
      case 0:
        return buffer.length >= 20 ? 20 : 0;
      case 2: {
        if (buffer.length < 4) return 0;
        const size = 4 + buffer.readUInt16BE(2) * 4;
        return buffer.length >= size ? size : 0;
      }
      case 3:
        if (buffer.length < 10) return 0;
        this.frameRequests += 1;
        if (!this.silent) {
          if (this.frameDelayMs) setTimeout(() => this.sendFrame(socket), this.frameDelayMs);
          else this.sendFrame(socket);
        }
        return 10;
      case 4:
        if (buffer.length < 8) return 0;
        this.events.push({ type: "key", down: buffer[1] === 1, keysym: buffer.readUInt32BE(4) });
        return 8;
      case 5:
        if (buffer.length < 6) return 0;
        this.events.push({ type: "pointer", mask: buffer[1]!, x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4) });
        return 6;
      case 6: {
        if (buffer.length < 8) return 0;
        const size = 8 + buffer.readUInt32BE(4);
        return buffer.length >= size ? size : 0;
      }
      default:
        socket.destroy();
        return buffer.length;
    }
  }

  private sendFrame(socket: Socket) {
    const parts: Buffer[] = [];
    const rects: Buffer[] = [];
    if (this.pendingResize) {
      // 合规顺序：DesktopSize 单独作为更新的最后一个矩形，客户端随后重新请求整屏。
      this.width = this.pendingResize.width;
      this.height = this.pendingResize.height;
      this.pendingResize = null;
      const resize = Buffer.alloc(16);
      resize.writeUInt16BE(1, 2);
      resize.writeUInt16BE(this.width, 8);
      resize.writeUInt16BE(this.height, 10);
      resize.writeInt32BE(-223, 12);
      socket.write(resize);
      return;
    }
    const rect = Buffer.alloc(12);
    rect.writeUInt16BE(this.width, 4);
    rect.writeUInt16BE(this.height, 6);
    rect.writeInt32BE(0, 8);
    const pixels = Buffer.alloc(this.width * this.height * 4);
    const pixel = this.options.pixel ?? ((x, y) => [x % 256, y % 256, 128] as [number, number, number]);
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const [r, g, b] = pixel(x, y);
        const offset = (y * this.width + x) * 4;
        pixels[offset] = b;
        pixels[offset + 1] = g;
        pixels[offset + 2] = r;
      }
    }
    rects.push(Buffer.concat([rect, pixels]));
    const header = Buffer.alloc(4);
    header.writeUInt16BE(rects.length, 2);
    parts.push(header, ...rects);
    socket.write(Buffer.concat(parts));
  }
}
