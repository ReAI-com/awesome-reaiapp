import { describe, expect, test } from "bun:test";
import { denormalize, parseActionReply } from "../src/agent-loop";

describe("parseActionReply", () => {
  test("裸 JSON 直接解析", () => {
    const parsed = parseActionReply('{"action":"click","x":100,"y":200}');
    expect(parsed?.action.action).toBe("click");
  });

  test("code fence 包裹的 JSON 解析", () => {
    const parsed = parseActionReply('```json\n{"action":"press","key":"enter"}\n```');
    expect(parsed?.action.action).toBe("press");
    expect((parsed?.action as { key: string }).key).toBe("enter");
  });

  test("带 thought 与闲话前后缀", () => {
    const parsed = parseActionReply(
      '好的，我先点击搜索框。\n{"action":"click","x":50,"y":120,"thought":"先聚焦输入框"}\n请继续。',
    );
    expect(parsed?.thought).toBe("先聚焦输入框");
    expect(parsed?.action.action).toBe("click");
  });

  test("done / fail 动作", () => {
    expect(parseActionReply('{"action":"done","detail":"消息已发送"}')?.action.action).toBe("done");
    expect(parseActionReply('{"action":"fail","detail":"找不到微信"}')?.action.action).toBe("fail");
  });

  test("click 缺坐标拒绝", () => {
    expect(parseActionReply('{"action":"click"}')).toBeNull();
    expect(parseActionReply('{"action":"click","x":"abc","y":10}')).toBeNull();
  });

  test("click 坐标为 null / false / 空串拒绝，数字字符串转成数字", () => {
    expect(parseActionReply('{"action":"click","x":null,"y":false}')).toBeNull();
    expect(parseActionReply('{"action":"click","x":"","y":10}')).toBeNull();
    const parsed = parseActionReply('{"action":"click","x":"120","y":30}');
    expect(parsed?.action).toEqual({ action: "click", x: 120, y: 30 });
  });

  test("字段不合法的动作拒绝，未知字段丢弃", () => {
    expect(parseActionReply('{"action":"type","text":123}')).toBeNull();
    expect(parseActionReply('{"action":"type","text":""}')).toBeNull();
    expect(parseActionReply('{"action":"press","key":"  "}')).toBeNull();
    expect(parseActionReply('{"action":"scroll"}')).toBeNull();
    expect(parseActionReply('{"action":"scroll","dy":"abc"}')).toBeNull();
    expect(parseActionReply('{"action":"click","x":1,"y":2,"button":"middle"}')).toBeNull();
    expect(parseActionReply('{"action":"click","x":1,"y":2,"double":"yes"}')).toBeNull();
    expect(parseActionReply('{"action":"shell","cmd":"rm -rf /"}')).toBeNull();
    expect(parseActionReply('{"action":"type","text":"hi","method":"computer.resume"}')?.action).toEqual({
      action: "type",
      text: "hi",
    });
    expect(parseActionReply('{"action":"scroll","dy":300}')?.action).toEqual({
      action: "scroll",
      dx: 0,
      dy: 300,
    });
  });

  test("完全不是 JSON 返回 null", () => {
    expect(parseActionReply("我认为应该点击右上角")).toBeNull();
  });
});

describe("denormalize", () => {
  const shot = { originX: 100, originY: 200, sourceWidth: 800, sourceHeight: 600 };

  test("0–1000 归一化换算屏幕坐标", () => {
    expect(denormalize(shot, 0, 0)).toEqual({ x: 100, y: 200 });
    expect(denormalize(shot, 1000, 1000)).toEqual({ x: 900, y: 800 });
    expect(denormalize(shot, 500, 500)).toEqual({ x: 500, y: 500 });
  });

  test("越界坐标钳制", () => {
    expect(denormalize(shot, -50, 1200)).toEqual({ x: 100, y: 800 });
  });

  test("图像被缩小时仍覆盖整块屏幕", () => {
    // 3840×2160 主屏缩到 1024×576 发给模型：换算必须按屏幕尺寸，
    // 按图像尺寸算的话「正中」会落在左上角约 1/4 处，右下大片点不到。
    const scaled = { originX: 0, originY: 0, sourceWidth: 3840, sourceHeight: 2160 };
    expect(denormalize(scaled, 1000, 1000)).toEqual({ x: 3840, y: 2160 });
    expect(denormalize(scaled, 500, 500)).toEqual({ x: 1920, y: 1080 });
  });

  test("副屏在主屏上方时原点为负照样成立", () => {
    const secondary = { originX: 0, originY: -1440, sourceWidth: 2560, sourceHeight: 1440 };
    expect(denormalize(secondary, 0, 0)).toEqual({ x: 0, y: -1440 });
    expect(denormalize(secondary, 1000, 1000)).toEqual({ x: 2560, y: 0 });
  });
});
