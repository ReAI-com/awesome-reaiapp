import { describe, expect, test } from "bun:test";
import { desEncryptBlock, vncAuthResponse } from "../src/rfb/des";

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const toHex = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("DES", () => {
  test("标准测试向量", () => {
    expect(toHex(desEncryptBlock(hex("133457799bbcdff1"), hex("0123456789abcdef")))).toBe("85e813540f0ab405");
  });

  test("另一组公开测试向量", () => {
    expect(toHex(desEncryptBlock(hex("0e329232ea6d0d73"), hex("8787878787878787")))).toBe("0000000000000000");
  });
});

describe("vncAuthResponse", () => {
  test("等价于用按位反转后的密码做 DES", () => {
    // "pass" → 0x70 0x61 0x73 0x73 按位反转 → 0e 86 ce ce，补零到 8 字节。
    const challenge = hex("00112233445566778899aabbccddeeff");
    const key = hex("0e86cece00000000");
    const expected = Buffer.concat([
      desEncryptBlock(key, challenge.subarray(0, 8)),
      desEncryptBlock(key, challenge.subarray(8)),
    ]);
    expect(toHex(vncAuthResponse("pass", challenge))).toBe(expected.toString("hex"));
  });

  test("密码超过 8 字节只取前 8 字节", () => {
    const challenge = new Uint8Array(16).fill(7);
    expect(toHex(vncAuthResponse("abcdefghXYZ", challenge))).toBe(toHex(vncAuthResponse("abcdefgh", challenge)));
  });
});
