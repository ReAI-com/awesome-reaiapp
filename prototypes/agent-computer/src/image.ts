/** 截图后处理：按最长边缩小、编码成 PNG。无第三方依赖。 */
import { deflateSync } from "node:zlib";
import type { Frame } from "./rfb/client";

/** 等比缩小到最长边不超过 maxEdge（只缩不放），按块取平均。 */
export function fitToMaxEdge(frame: Frame, maxEdge: number | undefined): Frame {
  const longest = Math.max(frame.width, frame.height);
  if (!maxEdge || maxEdge <= 0 || longest <= maxEdge) return frame;
  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * frame.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * frame.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * frame.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * frame.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const src = (sy * frame.width + sx) * 4;
          r += frame.rgba[src]!;
          g += frame.rgba[src + 1]!;
          b += frame.rgba[src + 2]!;
          count += 1;
        }
      }
      const dst = (y * width + x) * 4;
      rgba[dst] = Math.round(r / count);
      rgba[dst + 1] = Math.round(g / count);
      rgba[dst + 2] = Math.round(b / count);
      rgba[dst + 3] = 255;
    }
  }
  return { width, height, rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

/** RGBA → PNG（彩色 RGB，8 位，不带透明通道）。 */
export function encodePng(frame: Frame): Buffer {
  const { width, height, rgba } = frame;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = row + 1 + x * 3;
      raw[dst] = rgba[src]!;
      raw[dst + 1] = rgba[src + 1]!;
      raw[dst + 2] = rgba[src + 2]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
