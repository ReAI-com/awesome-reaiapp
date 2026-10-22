/**
 * 最小 RFB（VNC）客户端：只做 Agent 电脑需要的部分。
 *
 * - 协议版本 3.3 / 3.7 / 3.8（Apple 的 003.889 按 3.8 处理）
 * - 安全类型：None(1)、VNC 密码(2)
 * - 像素格式固定 32 位真彩色；编码只要 Raw(0) 与 DesktopSize(-223) 伪编码
 * - 输入：PointerEvent、KeyEvent
 *
 * 规范见 RFC 6143。显示端点与密码由 VmProvider 提供，本模块不打日志，
 * 也不在错误信息里带密码。
 */
import { connect, type Socket } from "node:net";
import { vncAuthResponse } from "./des";

export interface RfbConnectOptions {
  host: string;
  port: number;
  password?: string;
  timeoutMs?: number;
}

/** 客体帧缓冲，像素为 RGBA，每像素 4 字节。 */
export interface Frame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const ENCODING_RAW = 0;
const ENCODING_DESKTOP_SIZE = -223;
/** 服务端（客体）数据不可信：限制尺寸与各类长度，超限直接断开。 */
const MAX_EDGE = 8192;
const MAX_PIXELS = 7680 * 4320;
const MAX_NAME_BYTES = 4096;
const MAX_CUT_TEXT_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024 * 1024;

/** 按需读取固定字节数的缓冲读取器。 */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private waiter: { size: number; resolve: (data: Buffer) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  push(chunk: Buffer) {
    if (this.failure) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered > MAX_BUFFERED_BYTES) {
      this.chunks = [];
      this.buffered = 0;
      this.fail(new RfbError("RFB_PROTOCOL", "服务端数据超出缓冲上限"));
      return;
    }
    this.drain();
  }

  fail(error: Error) {
    this.failure = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  read(size: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("RFB 读取器不支持并发读取"));
    return new Promise((resolve, reject) => {
      this.waiter = { size, resolve, reject };
      this.drain();
    });
  }

  private drain() {
    if (!this.waiter || this.buffered < this.waiter.size) return;
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const { size, resolve } = this.waiter;
    this.waiter = null;
    const data = all.subarray(0, size);
    const rest = all.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    resolve(Buffer.from(data));
  }
}

export class RfbError extends Error {
  constructor(
    readonly code: "RFB_CONNECT" | "RFB_PROTOCOL" | "RFB_AUTH" | "RFB_TIMEOUT" | "RFB_CLOSED",
    message: string,
  ) {
    super(message);
    this.name = "RfbError";
  }
}

export class RfbClient {
  width = 0;
  height = 0;
  name = "";
  private framebuffer = new Uint8Array(0);
  private frameWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private closed = false;
  private closeListeners: Array<(error: Error) => void> = [];

  private constructor(
    private readonly socket: Socket,
    private readonly reader: ByteReader,
  ) {}

  static async connect(options: RfbConnectOptions): Promise<RfbClient> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const reader = new ByteReader();
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: options.host, port: options.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new RfbError("RFB_TIMEOUT", `连接 ${options.host}:${options.port} 超时`));
      }, timeoutMs);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (error) => {
        clearTimeout(timer);
        reject(new RfbError("RFB_CONNECT", `连接显示端点失败：${error.message}`));
      });
    });
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    const client = new RfbClient(socket, reader);
    socket.on("close", () => client.handleClose(new RfbError("RFB_CLOSED", "显示连接已断开")));
    socket.on("error", (error) => client.handleClose(new RfbError("RFB_CLOSED", `显示连接出错：${error.message}`)));

    const handshake = client.handshake(options.password);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    try {
      await handshake;
    } catch (error) {
      socket.destroy();
      if (client.closed && !(error instanceof RfbError && error.code === "RFB_AUTH")) {
        throw new RfbError("RFB_TIMEOUT", "RFB 握手超时或连接被关闭");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    void client.readLoop();
    return client;
  }

  onClose(listener: (error: Error) => void) {
    this.closeListeners.push(listener);
  }

  get isClosed() {
    return this.closed;
  }

  close() {
    this.socket.destroy();
  }

  /**
   * 请求一次完整画面并等待服务端送达。
   * 超时后直接断开连接：在途请求的迟到画面无法和下一次请求区分，宁可重连。
   */
  async captureFrame(timeoutMs = 10_000): Promise<Frame> {
    this.ensureOpen();
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.frameWaiters = this.frameWaiters.filter((waiter) => waiter !== entry);
        reject(new RfbError("RFB_TIMEOUT", "等待画面超时"));
        this.socket.destroy();
      }, timeoutMs);
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.frameWaiters.push(entry);
    });
    this.send(framebufferUpdateRequest(false, this.width, this.height));
    await done;
    return { width: this.width, height: this.height, rgba: this.framebuffer.slice() };
  }

  /** 鼠标事件：buttonMask 位 0=左 1=中 2=右 3/4=滚轮上/下 5/6=滚轮左/右。 */
  pointer(x: number, y: number, buttonMask: number) {
    this.ensureOpen();
    const message = Buffer.alloc(6);
    message.writeUInt8(5, 0);
    message.writeUInt8(buttonMask & 0xff, 1);
    message.writeUInt16BE(clamp(Math.round(x), 0, Math.max(0, this.width - 1)), 2);
    message.writeUInt16BE(clamp(Math.round(y), 0, Math.max(0, this.height - 1)), 4);
    this.send(message);
  }

  /** 键盘事件，keysym 为 X11 keysym。 */
  key(keysym: number, down: boolean) {
    this.ensureOpen();
    const message = Buffer.alloc(8);
    message.writeUInt8(4, 0);
    message.writeUInt8(down ? 1 : 0, 1);
    message.writeUInt32BE(keysym >>> 0, 4);
    this.send(message);
  }

  private async handshake(password?: string) {
    const version = (await this.reader.read(12)).toString("latin1");
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(version);
    if (!match) throw new RfbError("RFB_PROTOCOL", "不是 RFB 服务端");
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const useMinor = major > 3 || minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
    this.send(Buffer.from(`RFB 003.00${useMinor}\n`, "latin1"));

    let securityType: number;
    if (useMinor === 3) {
      securityType = (await this.reader.read(4)).readUInt32BE(0);
      if (securityType === 0) throw new RfbError("RFB_AUTH", await this.readReason());
    } else {
      const count = (await this.reader.read(1)).readUInt8(0);
      if (count === 0) throw new RfbError("RFB_AUTH", await this.readReason());
      const offered = [...(await this.reader.read(count))];
      if (password !== undefined && offered.includes(2)) securityType = 2;
      else if (offered.includes(1)) securityType = 1;
      else if (offered.includes(2)) throw new RfbError("RFB_AUTH", "服务端要求 VNC 密码，但没有提供");
      else throw new RfbError("RFB_AUTH", `不支持服务端提供的安全类型：${offered.join(",")}`);
      this.send(Buffer.from([securityType]));
    }

    if (securityType === 2) {
      const challenge = await this.reader.read(16);
      this.send(Buffer.from(vncAuthResponse(password ?? "", challenge)));
    } else if (securityType !== 1) {
      throw new RfbError("RFB_AUTH", `不支持的安全类型：${securityType}`);
    }

    if (securityType === 2 || useMinor === 8) {
      const result = (await this.reader.read(4)).readUInt32BE(0);
      if (result !== 0) {
        const reason = useMinor === 8 ? await this.readReason() : "认证失败";
        throw new RfbError("RFB_AUTH", `VNC 认证失败：${reason}`);
      }
    }

    // ClientInit：shared=1，不踢掉其他观看者。
    this.send(Buffer.from([1]));
    const init = await this.reader.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    assertSize(this.width, this.height);
    const nameLength = init.readUInt32BE(20);
    if (nameLength > MAX_NAME_BYTES) throw new RfbError("RFB_PROTOCOL", "服务端名称过长");
    this.name = (await this.reader.read(nameLength)).toString("utf8");
    this.framebuffer = new Uint8Array(this.width * this.height * 4);

    this.send(setPixelFormat());
    this.send(setEncodings([ENCODING_RAW, ENCODING_DESKTOP_SIZE]));
  }

  private async readReason(): Promise<string> {
    const length = (await this.reader.read(4)).readUInt32BE(0);
    if (length > MAX_NAME_BYTES) throw new RfbError("RFB_PROTOCOL", "服务端原因说明过长");
    return (await this.reader.read(length)).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " ");
  }

  private async readLoop() {
    try {
      for (;;) {
        const type = (await this.reader.read(1)).readUInt8(0);
        switch (type) {
          case 0:
            await this.readFramebufferUpdate();
            break;
          case 1: {
            const header = await this.reader.read(5);
            await this.reader.read(header.readUInt16BE(3) * 6);
            break;
          }
          case 2:
            break;
          case 3: {
            const header = await this.reader.read(7);
            const length = header.readUInt32BE(3);
            if (length > MAX_CUT_TEXT_BYTES) throw new RfbError("RFB_PROTOCOL", "服务端剪贴板数据过长");
            await this.reader.read(length);
            break;
          }
          default:
            throw new RfbError("RFB_PROTOCOL", `未知的服务端消息类型：${type}`);
        }
      }
    } catch (error) {
      this.socket.destroy();
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async readFramebufferUpdate() {
    const header = await this.reader.read(3);
    const rects = header.readUInt16BE(1);
    let resized = false;
    for (let i = 0; i < rects; i += 1) {
      const rect = await this.reader.read(12);
      const x = rect.readUInt16BE(0);
      const y = rect.readUInt16BE(2);
      const w = rect.readUInt16BE(4);
      const h = rect.readUInt16BE(6);
      const encoding = rect.readInt32BE(8);
      if (encoding === ENCODING_DESKTOP_SIZE) {
        assertSize(w, h);
        this.width = w;
        this.height = h;
        this.framebuffer = new Uint8Array(w * h * 4);
        resized = true;
        continue;
      }
      if (encoding !== ENCODING_RAW) throw new RfbError("RFB_PROTOCOL", `服务端使用了未协商的编码：${encoding}`);
      if (x + w > this.width || y + h > this.height) throw new RfbError("RFB_PROTOCOL", "矩形超出帧缓冲范围");
      const pixels = await this.reader.read(w * h * 4);
      for (let row = 0; row < h; row += 1) {
        for (let col = 0; col < w; col += 1) {
          const src = (row * w + col) * 4;
          const dst = ((y + row) * this.width + (x + col)) * 4;
          // 协商的格式：小端 32 位，red-shift 16 / green 8 / blue 0 → 字节序 B G R X。
          this.framebuffer[dst] = pixels[src + 2]!;
          this.framebuffer[dst + 1] = pixels[src + 1]!;
          this.framebuffer[dst + 2] = pixels[src]!;
          this.framebuffer[dst + 3] = 255;
        }
      }
    }
    if (resized) {
      // 尺寸变化后帧缓冲是空的（RFC 6143 §7.8.2：DesktopSize 位于更新末尾）：
      // 重新请求整屏，收到像素后才算完成截图。
      if (this.frameWaiters.length) this.send(framebufferUpdateRequest(false, this.width, this.height));
      return;
    }
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private send(data: Buffer) {
    this.socket.write(data);
  }

  private ensureOpen() {
    if (this.closed) throw new RfbError("RFB_CLOSED", "显示连接已断开");
  }

  private handleClose(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.reader.fail(error);
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
    for (const listener of this.closeListeners) listener(error);
  }
}

function assertSize(width: number, height: number) {
  if (width === 0 || height === 0 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new RfbError("RFB_PROTOCOL", `服务端画面尺寸不合理：${width}×${height}`);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function framebufferUpdateRequest(incremental: boolean, width: number, height: number): Buffer {
  const message = Buffer.alloc(10);
  message.writeUInt8(3, 0);
  message.writeUInt8(incremental ? 1 : 0, 1);
  message.writeUInt16BE(width, 6);
  message.writeUInt16BE(height, 8);
  return message;
}

function setPixelFormat(): Buffer {
  const message = Buffer.alloc(20);
  message.writeUInt8(0, 0);
  const format = 4;
  message.writeUInt8(32, format); // bits-per-pixel
  message.writeUInt8(24, format + 1); // depth
  message.writeUInt8(0, format + 2); // big-endian：否
  message.writeUInt8(1, format + 3); // true-colour
  message.writeUInt16BE(255, format + 4);
  message.writeUInt16BE(255, format + 6);
  message.writeUInt16BE(255, format + 8);
  message.writeUInt8(16, format + 10);
  message.writeUInt8(8, format + 11);
  message.writeUInt8(0, format + 12);
  return message;
}

function setEncodings(encodings: number[]): Buffer {
  const message = Buffer.alloc(4 + encodings.length * 4);
  message.writeUInt8(2, 0);
  message.writeUInt16BE(encodings.length, 2);
  encodings.forEach((encoding, i) => message.writeInt32BE(encoding, 4 + i * 4));
  return message;
}
