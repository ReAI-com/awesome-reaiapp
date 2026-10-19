/**
 * 当前是否处于开发者模式（Host `environment.developerMode`）。
 *
 * 错误主句在展示时按这个开关求值：普通模式只给插件自己的固定人话，开发者模式才可带上游原文。
 * 开关变化由 `environment.onChange` 写入；默认按普通模式处理，宁可少说也不泄露诊断。
 */
let developerMode = false;

export function voiceDeveloperMode(): boolean {
  return developerMode;
}

export function setVoiceDeveloperMode(value: boolean): void {
  developerMode = value === true;
}

/** 以普通模式口径同步求值（会落盘或离开插件页面的文字用），不受当前开关影响。 */
export function inPlainMode<T>(read: () => T): T {
  const previous = developerMode;
  developerMode = false;
  try { return read(); } finally { developerMode = previous; }
}
