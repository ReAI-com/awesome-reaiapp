/**
 * 按键名 / 文字 → X11 keysym（RFB KeyEvent 用）。
 *
 * 组合键写法与现有 computer.key.press 一致：「cmd+c」「ctrl+shift+tab」「enter」。
 */

const NAMED: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  space: 0x20,
  up: 0xff52,
  down: 0xff54,
  left: 0xff51,
  right: 0xff53,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  capslock: 0xffe5,
};
for (let i = 1; i <= 12; i += 1) NAMED[`f${i}`] = 0xffbd + i;

/** 修饰键 → keysym 的映射表。不同显示通道对修饰键的解释不同。 */
export type ModifierMap = Record<string, number>;

/** 常规 X11 约定（Windows 客体等）。 */
export const STANDARD_MODIFIERS: ModifierMap = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  option: 0xffe9,
  opt: 0xffe9,
  cmd: 0xffeb,
  command: 0xffeb,
  meta: 0xffeb,
  super: 0xffeb,
  win: 0xffeb,
};

/**
 * Virtualization.framework 内置 VNC 的 macOS 客体（2026-10-21 真机实测）：
 * Alt_L(0xffe9) 是 Command，Meta_L(0xffe7) 是 Option，Super_L 无效。
 */
export const VZ_MACOS_MODIFIERS: ModifierMap = {
  ...STANDARD_MODIFIERS,
  alt: 0xffe7,
  option: 0xffe7,
  opt: 0xffe7,
  cmd: 0xffe9,
  command: 0xffe9,
  meta: 0xffe9,
  super: 0xffe9,
  win: 0xffe9,
};

/** US 键盘布局下需要按住 Shift 的符号 → 对应的基础键。 */
const US_SHIFTED: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/",
};

export interface KeyStroke {
  keysym: number;
  shift: boolean;
}

/**
 * 按物理键盘（US 布局）输入一个字符需要的按键。
 *
 * Virtualization.framework 的 VNC 只把 keysym 映射成物理键码、不自动补 Shift：
 * 直接发「H」会输入「h」，发「!」会输入「1」（2026-10-21 真机实测）。因此大写与
 * 符号要拆成 Shift + 基础键。非 ASCII 字符返回 null，交给其他输入通道。
 */
export function usKeyStroke(char: string): KeyStroke | null {
  if (char === "\n" || char === "\r" || char === "\t") return { keysym: charKeysym(char), shift: false };
  const cp = char.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp > 0x7e) return null;
  if (char >= "A" && char <= "Z") return { keysym: char.toLowerCase().charCodeAt(0), shift: true };
  const base = US_SHIFTED[char];
  if (base) return { keysym: base.charCodeAt(0), shift: true };
  return { keysym: cp, shift: false };
}

export interface KeyCombo {
  modifiers: number[];
  key: number;
}

/** 单个字符的 keysym：Latin-1 直接用码位，其他字符用 0x01000000 + Unicode 码位。 */
export function charKeysym(char: string): number {
  const cp = char.codePointAt(0);
  if (cp === undefined) throw new Error("空字符");
  if (char === "\n" || char === "\r") return NAMED.enter!;
  if (char === "\t") return NAMED.tab!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

export function parseCombo(spec: string, modifierMap: ModifierMap = STANDARD_MODIFIERS): KeyCombo {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error(`按键为空：${JSON.stringify(spec)}`);
  const last = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1).map((name) => {
    const keysym = modifierMap[name];
    if (keysym === undefined) throw new Error(`未知的修饰键：${name}`);
    return keysym;
  });
  let key: number | undefined = NAMED[last] ?? modifierMap[last];
  if (key === undefined) {
    if ([...last].length !== 1) throw new Error(`未知的按键：${last}`);
    // 组合键里的字符一律按物理键（基础键）发送，Shift 需显式写出。
    const stroke = usKeyStroke(last);
    if (!stroke) throw new Error(`组合键不支持非 ASCII 字符：${last}`);
    key = stroke.keysym;
  }
  return { modifiers, key };
}
