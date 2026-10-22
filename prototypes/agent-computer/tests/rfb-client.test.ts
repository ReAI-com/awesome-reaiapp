import { afterEach, describe, expect, test } from "bun:test";
import { RfbClient, RfbError } from "../src/rfb/client";
import { FakeRfbServer } from "./fake-rfb-server";

let server: FakeRfbServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

const waitFor = async (check: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await Bun.sleep(5);
  }
};

describe("RfbClient", () => {
  for (const version of ["RFB 003.003\n", "RFB 003.007\n", "RFB 003.008\n", "RFB 003.889\n"]) {
    test(`握手并截取画面（${version.trim()}，无认证）`, async () => {
      server = await FakeRfbServer.start({ version, width: 4, height: 3 });
      const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
      expect([client.width, client.height, client.name]).toEqual([4, 3, "fake"]);
      const frame = await client.captureFrame();
      expect(frame.width).toBe(4);
      // 像素 (2,1) = RGB(2,1,128)
      const offset = (1 * 4 + 2) * 4;
      expect([...frame.rgba.subarray(offset, offset + 4)]).toEqual([2, 1, 128, 255]);
      client.close();
    });
  }

  test("VNC 密码认证成功", async () => {
    server = await FakeRfbServer.start({ password: "s3cret" });
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port, password: "s3cret" });
    expect(client.width).toBe(64);
    client.close();
  });

  test("密码错误报认证失败，错误里不含密码", async () => {
    server = await FakeRfbServer.start({ password: "s3cret" });
    const error = await RfbClient.connect({ host: "127.0.0.1", port: server.port, password: "wrong-pass" }).catch((e) => e);
    expect(error).toBeInstanceOf(RfbError);
    expect((error as RfbError).code).toBe("RFB_AUTH");
    expect(String(error.message)).not.toContain("wrong-pass");
  });

  test("服务端要密码但没给", async () => {
    server = await FakeRfbServer.start({ password: "s3cret" });
    const error = await RfbClient.connect({ host: "127.0.0.1", port: server.port }).catch((e) => e);
    expect((error as RfbError).code).toBe("RFB_AUTH");
  });

  test("服务端报告不合理的超大尺寸：拒绝连接", async () => {
    server = await FakeRfbServer.start({ width: 9000, height: 9000 });
    const error = await RfbClient.connect({ host: "127.0.0.1", port: server.port }).catch((e) => e);
    expect((error as RfbError).code).toBe("RFB_PROTOCOL");
  });

  test("连接不上报 RFB_CONNECT", async () => {
    const error = await RfbClient.connect({ host: "127.0.0.1", port: 1, timeoutMs: 500 }).catch((e) => e);
    expect((error as RfbError).code).toBe("RFB_CONNECT");
  });

  test("鼠标与键盘事件按顺序送达，坐标钳制在画面内", async () => {
    server = await FakeRfbServer.start({ width: 100, height: 50 });
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
    client.pointer(10, 20, 1);
    client.pointer(500, -3, 0);
    client.key(0x61, true);
    client.key(0x61, false);
    await waitFor(() => server!.events.length === 4);
    expect(server.events).toEqual([
      { type: "pointer", x: 10, y: 20, mask: 1 },
      { type: "pointer", x: 99, y: 0, mask: 0 },
      { type: "key", keysym: 0x61, down: true },
      { type: "key", keysym: 0x61, down: false },
    ]);
    client.close();
  });

  test("分辨率变化后画面尺寸跟着变", async () => {
    server = await FakeRfbServer.start({ width: 8, height: 8 });
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
    server.resize(16, 4);
    const frame = await client.captureFrame();
    expect([frame.width, frame.height, frame.rgba.length]).toEqual([16, 4, 16 * 4 * 4]);
    // 返回的是尺寸变化后重新请求到的真实像素，不是空帧：像素 (3,2) = RGB(3,2,128)。
    const offset = (2 * 16 + 3) * 4;
    expect([...frame.rgba.subarray(offset, offset + 4)]).toEqual([3, 2, 128, 255]);
    client.close();
  });

  test("截图超时会断开连接，迟到画面不会被下一次截图误用", async () => {
    server = await FakeRfbServer.start();
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
    server.silent = true;
    const error = await client.captureFrame(50).catch((e) => e);
    expect((error as RfbError).code).toBe("RFB_TIMEOUT");
    await waitFor(() => client.isClosed);
  });

  test("断开时等待中的截图立即失败", async () => {
    server = await FakeRfbServer.start();
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
    server.silent = true;
    const pending = client.captureFrame(5_000).catch((e) => e);
    server.dropConnections();
    const error = await pending;
    expect((error as RfbError).code).toBe("RFB_CLOSED");
  });

  test("断开后通知监听者，之后的输入报 RFB_CLOSED", async () => {
    server = await FakeRfbServer.start();
    const client = await RfbClient.connect({ host: "127.0.0.1", port: server.port });
    let notified = false;
    client.onClose(() => {
      notified = true;
    });
    server.dropConnections();
    await waitFor(() => notified);
    expect(() => client.pointer(1, 1, 0)).toThrow(RfbError);
  });
});
