// Cor: conversões sRGB <-> OKLCH e escalas do mapa.
//
// Regras (skill dataviz):
//  - a cor do candidato vem de meta.json (`cor`) e é o matiz; a margem controla
//    luminosidade/saturação em 5 degraus discretos (ordinal, uma só tonalidade);
//  - em disputa de 2 candidatos o mapa é uma escala divergente: cor A ← cinza → cor B,
//    com o cinza neutro no empate;
//  - modo escuro tem seus próprios degraus (não é um "flip" automático).

export type RGB = [number, number, number];
export interface OKLCH {
  l: number;
  c: number;
  h: number;
}

export function hexToRgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (x: number) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

const srgbToLinear = (c: number): number => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
};

export function rgbToOklch([r, g, b]: RGB): OKLCH {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function oklchToLinearRgb({ l, c, h }: OKLCH): RGB {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

/** Converte para sRGB reduzindo a croma até caber no gamut (mantém L e H). */
export function oklchToHex(col: OKLCH): string {
  let c = col.c;
  for (let i = 0; i < 12; i++) {
    const lin = oklchToLinearRgb({ l: col.l, c, h: col.h });
    if (lin.every((v) => v >= -0.0005 && v <= 1.0005)) {
      return rgbToHex(lin.map(linearToSrgb) as RGB);
    }
    c *= 0.8;
  }
  const lin = oklchToLinearRgb({ l: col.l, c: 0, h: col.h });
  return rgbToHex(lin.map((v) => linearToSrgb(Math.max(0, Math.min(1, v)))) as RGB);
}

export const hexToOklch = (hex: string): OKLCH => rgbToOklch(hexToRgb(hex));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Degraus de margem (p.p.) — limites superiores de cada faixa. */
export const DEGRAUS = [2, 5, 10, 20, Infinity];
export const DEGRAU_LABELS = ['<2', '2–5', '5–10', '10–20', '>20'];

export function degrauMargem(margemPct: number): number {
  for (let i = 0; i < DEGRAUS.length; i++) if (margemPct < DEGRAUS[i]) return i;
  return DEGRAUS.length - 1;
}

/**
 * Cor "de exibição" de um candidato (barras, avatares, legendas): a cor do
 * meta.json ajustada para contrastar ≥ 3:1 com a superfície do modo.
 */
export function corCandidato(hex: string, escuro: boolean): string {
  const o = hexToOklch(hex);
  if (escuro) return oklchToHex({ l: Math.max(o.l, 0.68), c: Math.max(o.c, 0.1), h: o.h });
  return oklchToHex({ l: Math.min(o.l, 0.55), c: Math.max(o.c, 0.1), h: o.h });
}

/** Cor de texto (branco ou tinta) legível sobre um preenchimento. */
export function textoSobre(hex: string): string {
  const { l } = hexToOklch(hex);
  return l > 0.62 ? '#141413' : '#ffffff';
}

/**
 * Rampa ordinal de 5 degraus para o matiz do candidato. Índice 0 = margem apertada
 * (claro no modo claro / escuro no modo escuro), índice 4 = margem larga (cor cheia).
 * Delta L entre degraus ≥ 0.07 em ambos os modos (checagem ordinal da skill).
 */
export function rampaCandidato(hex: string, escuro: boolean): string[] {
  const o = hexToOklch(hex);
  const h = o.h;
  const cBase = Math.max(o.c, 0.12);
  const out: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    if (escuro) {
      const l = lerp(0.36, 0.72, t);
      const c = lerp(0.045, Math.min(cBase, 0.17), t);
      out.push(oklchToHex({ l, c, h }));
    } else {
      const l = lerp(0.9, 0.5, t);
      const c = lerp(0.045, Math.min(cBase, 0.2), t);
      out.push(oklchToHex({ l, c, h }));
    }
  }
  return out;
}

export interface Paleta {
  /** por índice de candidato: 5 cores (degrau de margem) */
  rampas: string[][];
  /** cor de exibição por índice de candidato */
  cores: string[];
  escuro: boolean;
}

export function montarPaleta(coresMeta: string[], escuro: boolean): Paleta {
  return {
    rampas: coresMeta.map((c) => rampaCandidato(c, escuro)),
    cores: coresMeta.map((c) => corCandidato(c, escuro)),
    escuro,
  };
}

export const modoEscuro = (): boolean => {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark') return true;
  if (forced === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

export function lerVar(nome: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
}
