/**
 * VNC 认证（RFB 安全类型 2）所需的单块 DES-ECB 加密。
 *
 * 只实现加密方向、单个 8 字节块：VNC 认证是用密码对服务端 16 字节随机挑战
 * 做两次 DES。Bun 自带的 OpenSSL 3 默认不再提供 DES，因此这里自带一份。
 */

const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const S = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** 字节数组 → 位数组（高位在前）。 */
function toBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];
  for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  return bits;
}

function fromBits(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) out[i >> 3]! |= bits[i]! << (7 - (i & 7));
  return out;
}

function permute(bits: number[], table: number[]): number[] {
  return table.map((position) => bits[position - 1]!);
}

function rotate(bits: number[], count: number): number[] {
  return [...bits.slice(count), ...bits.slice(0, count)];
}

/** 标准 DES 加密一个 8 字节块。 */
export function desEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (key.length !== 8 || block.length !== 8) throw new Error("DES 需要 8 字节密钥与 8 字节数据块");
  const keyBits = permute(toBits(key), PC1);
  let c = keyBits.slice(0, 28);
  let d = keyBits.slice(28);
  const subKeys: number[][] = [];
  for (const shift of SHIFTS) {
    c = rotate(c, shift);
    d = rotate(d, shift);
    subKeys.push(permute([...c, ...d], PC2));
  }

  const data = permute(toBits(block), IP);
  let left = data.slice(0, 32);
  let right = data.slice(32);
  for (const subKey of subKeys) {
    const expanded = permute(right, E).map((bit, i) => bit ^ subKey[i]!);
    const sOut: number[] = [];
    for (let box = 0; box < 8; box += 1) {
      const chunk = expanded.slice(box * 6, box * 6 + 6);
      const row = (chunk[0]! << 1) | chunk[5]!;
      const column = (chunk[1]! << 3) | (chunk[2]! << 2) | (chunk[3]! << 1) | chunk[4]!;
      const value = S[box]![row * 16 + column]!;
      for (let i = 3; i >= 0; i -= 1) sOut.push((value >> i) & 1);
    }
    const mixed = permute(sOut, P).map((bit, i) => bit ^ left[i]!);
    left = right;
    right = mixed;
  }
  return fromBits(permute([...right, ...left], FP));
}

/** VNC 把密码每个字节按位反转后当 DES 密钥（历史遗留的 d3des 约定）。 */
function vncKey(password: string): Uint8Array {
  const key = new Uint8Array(8);
  const raw = new TextEncoder().encode(password).slice(0, 8);
  raw.forEach((byte, i) => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) if (byte & (1 << bit)) reversed |= 1 << (7 - bit);
    key[i] = reversed;
  });
  return key;
}

/** 计算 VNC 认证应答：用密码加密 16 字节挑战。 */
export function vncAuthResponse(password: string, challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 16) throw new Error("VNC 挑战必须是 16 字节");
  const key = vncKey(password);
  const out = new Uint8Array(16);
  out.set(desEncryptBlock(key, challenge.subarray(0, 8)), 0);
  out.set(desEncryptBlock(key, challenge.subarray(8, 16)), 8);
  return out;
}
