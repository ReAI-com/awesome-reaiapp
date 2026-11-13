import type { OrbState } from "./types";

export interface Os1OrbController {
  setState(state: OrbState): void;
  setAudioEnergy(energy: number | null): void;
  refreshPalette(): void;
  dispose(): void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 电影《她》(Her) OS1 风格有机声波圆环渲染器：
 * - 待机 (idle)：静谧呼吸纤细圆环
 * - 唤醒 (connecting)：四点水平轻浮 → 聚拢绽放为圆环
 * - 倾听 (listening)：双层微澜柔光圆环
 * - 思考 (thinking)：平滑插值扭转为 OS1 经典斜倾 ∞ 莫比乌斯丝带
 * - 回应 (speaking)：低阶流体谐波驱动圆环有机揉动（支持外部真实音频能量或预览模拟韵律）
 */
export function mountOs1OrbCanvas(canvas: HTMLCanvasElement, colorSourceEl: HTMLElement): Os1OrbController {
  const win = canvas.ownerDocument.defaultView;
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  const logicalSize = 320;

  let state: OrbState = "idle";
  let externalEnergy: number | null = null;
  let stateEnteredAt = win?.performance?.now() ?? 0;
  let morphTwist = 0;
  let voiceEnergy = 0;
  let listenRipple = 0;
  let rafId: number | null = null;
  let disposed = false;

  let primaryStroke = "#d9533f";
  let secondaryStroke = "rgba(217, 83, 63, 0.24)";

  const readPalette = () => {
    if (!win) return;
    const style = win.getComputedStyle(colorSourceEl);
    const p = style.getPropertyValue("--vc-orb").trim();
    const s = style.getPropertyValue("--vc-orb-soft").trim();
    if (p) primaryStroke = p;
    if (s) secondaryStroke = s;
  };

  const setupHiDpi = () => {
    if (!ctx || !win) return;
    const dpr = Math.min(3, Math.max(1, win.devicePixelRatio || 1));
    canvas.width = Math.round(logicalSize * dpr);
    canvas.height = Math.round(logicalSize * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const prefersReducedMotion = (): boolean =>
    Boolean(win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  const drawOrganicLoop = (params: {
    cx: number;
    cy: number;
    baseR: number;
    t: number;
    twist: number;
    energy: number;
    listen: number;
    stroke: string;
    lineWidth: number;
    phaseShift: number;
  }) => {
    if (!ctx) return;
    const { cx, cy, baseR, t, twist, energy, listen, stroke, lineWidth, phaseShift } = params;
    const steps = 180;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(twist * (-0.32 + Math.sin(t * 0.9) * 0.08));

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const knead =
        energy *
          (10.2 * Math.sin(2 * theta + t * 4.2 + phaseShift) +
            7.0 * Math.sin(3 * theta - t * 5.6 + phaseShift * 1.7) +
            4.2 * Math.cos(4 * theta + t * 7.1) +
            2.6 * Math.sin(5 * theta - t * 3.3)) +
        listen *
          (3.2 * Math.sin(3 * theta + t * 2.6 + phaseShift) +
            2.0 * Math.cos(2 * theta - t * 1.9));

      const idleOrganic = 1.0 * Math.sin(2 * theta + t * 1.1 + phaseShift);
      const r = baseR + knead * (1 - twist * 0.75) + idleOrganic;

      const circleX = r * Math.cos(theta);
      const circleY = r * Math.sin(theta);

      const ribbonPhase = t * 2.35 + phaseShift * 0.5;
      const infX = r * 1.16 * Math.cos(theta);
      const infY = r * 0.56 * Math.sin(2 * theta + ribbonPhase);

      const x = lerp(circleX, infX, twist);
      const y = lerp(circleY, infY, twist);

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  };

  const renderFrame = (now: number) => {
    if (disposed || !ctx) return;
    const reduced = prefersReducedMotion();
    const t = reduced ? 0 : now * 0.001;
    ctx.clearRect(0, 0, logicalSize, logicalSize);

    const cx = logicalSize / 2;
    const cy = logicalSize / 2;

    const targetTwist = state === "thinking" ? 1 : 0;
    morphTwist = reduced ? targetTwist : lerp(morphTwist, targetTwist, 0.065);

    const targetListen = state === "listening" ? 1 : 0;
    listenRipple = reduced ? targetListen : lerp(listenRipple, targetListen, 0.085);

    let targetEnergy = 0;
    if (externalEnergy !== null) {
      targetEnergy = Math.max(0, Math.min(1, externalEnergy));
    } else if (state === "speaking") {
      if (reduced) {
        targetEnergy = 0.25;
      } else {
        const syllable =
          0.44 +
          0.32 * Math.sin(t * 5.8) +
          0.22 * Math.sin(t * 9.3 + 1.1) +
          0.18 * Math.cos(t * 3.1);
        const pauseGate = Math.sin(t * 1.45) > -0.65 ? 1 : 0.12;
        targetEnergy = Math.max(0.06, Math.min(1, syllable * pauseGate));
      }
    } else if (state === "listening") {
      targetEnergy = reduced ? 0.1 : 0.15 + 0.09 * Math.sin(t * 3.3) * Math.cos(t * 1.8);
    }
    voiceEnergy = reduced ? targetEnergy : lerp(voiceEnergy, targetEnergy, 0.14);

    if (state === "connecting" && !reduced) {
      const elapsed = Math.min(1, Math.max(0, (now - stateEnteredAt) / 1350));
      const gather = 1 - Math.pow(1 - Math.min(1, elapsed * 1.35), 3);
      const bloom = elapsed > 0.44 ? Math.pow((elapsed - 0.44) / 0.56, 2) : 0;

      if (bloom < 0.92) {
        const offsets = [-40, -13.5, 13.5, 40];
        ctx.fillStyle = primaryStroke;
        offsets.forEach((ox, idx) => {
          const x = cx + ox * (1 - gather);
          const y = cy + Math.sin(t * 5 + idx) * 2.8 * (1 - gather);
          const r = Math.max(0.5, lerp(4.0, 6.2, gather) * (1 - bloom * 0.72));
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      if (bloom > 0.02) {
        ctx.strokeStyle = primaryStroke;
        ctx.lineWidth = lerp(2.0, 3.1, bloom);
        ctx.beginPath();
        ctx.arc(cx, cy, lerp(6, 72, bloom), 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      const baseR = 72 + Math.sin(t * 1.35) * 2.2 + voiceEnergy * 10.5;
      if (voiceEnergy > 0.04 || morphTwist > 0.04) {
        drawOrganicLoop({
          cx,
          cy,
          baseR: baseR * (1 + voiceEnergy * 0.08),
          t: t * 1.04 + 0.85,
          twist: morphTwist,
          energy: voiceEnergy * 1.24,
          listen: listenRipple,
          stroke: secondaryStroke,
          lineWidth: lerp(2.0, 5.2, voiceEnergy),
          phaseShift: 1.2,
        });
      }

      drawOrganicLoop({
        cx,
        cy,
        baseR,
        t,
        twist: morphTwist,
        energy: voiceEnergy,
        listen: listenRipple,
        stroke: primaryStroke,
        lineWidth: lerp(2.6, 4.4, Math.max(voiceEnergy, morphTwist * 0.6)),
        phaseShift: 0,
      });
    }

    if (win?.requestAnimationFrame) {
      rafId = win.requestAnimationFrame(renderFrame);
    }
  };

  setupHiDpi();
  readPalette();
  if (ctx && win?.requestAnimationFrame) {
    rafId = win.requestAnimationFrame(renderFrame);
  }

  return {
    setState(next: OrbState) {
      if (state === next) return;
      state = next;
      stateEnteredAt = win?.performance?.now() ?? 0;
    },
    setAudioEnergy(energy: number | null) {
      externalEnergy = energy;
    },
    refreshPalette() {
      readPalette();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId !== null && win?.cancelAnimationFrame) {
        win.cancelAnimationFrame(rafId);
      }
      rafId = null;
    },
  };
}
