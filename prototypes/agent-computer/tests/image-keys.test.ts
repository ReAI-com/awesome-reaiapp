import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng, fitToMaxEdge } from "../src/image";
import { VZ_MACOS_MODIFIERS, charKeysym, parseCombo, usKeyStroke } from "../src/keys";

const solid = (width: number, height: number, rgb: [number, number, number]) => {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([...rgb, 255], i * 4);
  return { width, height, rgba };
};

describe("fitToMaxEdge", () => {
  test("等比缩小到最长边", () => {
    const out = fitToMaxEdge(solid(2048, 1280, [10, 20, 30]), 1024);
    expect([out.width, out.height]).toEqual([1024, 640]);
    expect([...out.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
  });

  test("小图和未指定时不处理", () => {
    const frame = solid(100, 50, [1, 2, 3]);
    expect(fitToMaxEdge(frame, 1024)).toBe(frame);
    expect(fitToMaxEdge(frame, undefined)).toBe(frame);
  });

  test("按块平均", () => {
    const frame = { width: 2, height: 1, rgba: Uint8Array.from([0, 0, 0, 255, 200, 100, 50, 255]) };
    expect([...fitToMaxEdge(frame, 1).rgba]).toEqual([100, 50, 25, 255]);
  });
});

describe("encodePng", () => {
  test("合法 PNG：签名、尺寸与像素", () => {
    const png = encodePng(solid(3, 2, [255, 0, 0]));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    const idatLength = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect([...raw.subarray(0, 4)]).toEqual([0, 255, 0, 0]);
  });
});

describe("keys", () => {
  test("字符 keysym", () => {
    expect(charKeysym("a")).toBe(0x61);
    expect(charKeysym("A")).toBe(0x41);
    expect(charKeysym("\n")).toBe(0xff0d);
    expect(charKeysym("中")).toBe(0x01004e2d);
    expect(charKeysym("😀")).toBe(0x0101f600);
  });

  test("组合键", () => {
    expect(parseCombo("enter")).toEqual({ modifiers: [], key: 0xff0d });
    expect(parseCombo("Cmd+C")).toEqual({ modifiers: [0xffeb], key: 0x63 });
    expect(parseCombo("ctrl+shift+tab")).toEqual({ modifiers: [0xffe3, 0xffe1], key: 0xff09 });
    expect(parseCombo("f5").key).toBe(0xffc2);
  });

  test("VZ 映射：cmd 是 Alt_L、option 是 Meta_L；组合键字符按基础键", () => {
    expect(parseCombo("cmd+v", VZ_MACOS_MODIFIERS)).toEqual({ modifiers: [0xffe9], key: 0x76 });
    expect(parseCombo("option+e", VZ_MACOS_MODIFIERS)).toEqual({ modifiers: [0xffe7], key: 0x65 });
    expect(parseCombo("cmd+shift+A", VZ_MACOS_MODIFIERS).key).toBe(0x61);
  });

  test("US 布局物理键", () => {
    expect(usKeyStroke("H")).toEqual({ keysym: 0x68, shift: true });
    expect(usKeyStroke("!")).toEqual({ keysym: 0x31, shift: true });
    expect(usKeyStroke("|")).toEqual({ keysym: 0x5c, shift: true });
    expect(usKeyStroke("?")).toEqual({ keysym: 0x2f, shift: true });
    expect(usKeyStroke("a")).toEqual({ keysym: 0x61, shift: false });
    expect(usKeyStroke("\n")).toEqual({ keysym: 0xff0d, shift: false });
    expect(usKeyStroke("中")).toBeNull();
  });

  test("未知按键报错", () => {
    expect(() => parseCombo("hyper+x")).toThrow("未知的修饰键");
    expect(() => parseCombo("launch")).toThrow("未知的按键");
    expect(() => parseCombo("")).toThrow("按键为空");
    expect(() => parseCombo("cmd+中")).toThrow("非 ASCII");
  });
});
