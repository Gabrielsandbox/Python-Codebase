// Formatação pt-BR e animações numéricas (count-up).

const nfInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const nfPct2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfPct1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nfCompact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtInt = (n: number): string => nfInt.format(Math.round(n));
export const fmtPct = (n: number, digits: 1 | 2 = 2): string =>
  (digits === 2 ? nfPct2 : nfPct1).format(n) + '%';
export const fmtPP = (n: number): string => nfPct2.format(n) + ' p.p.';
export const fmtCompact = (n: number): string => nfCompact.format(n);

const dtDia = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
const dtHora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const dtHoraSeg = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/Sao_Paulo' });

export function fmtDataLonga(iso: string): string {
  // "2026-10-25" → "25 de outubro de 2026" (meio-dia para evitar virada de fuso)
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00-03:00' : iso);
  return dtDia.format(d);
}
export const fmtHora = (iso: string): string => dtHora.format(new Date(iso));
export const fmtHoraSeg = (iso: string): string => dtHoraSeg.format(new Date(iso));

/** "há 12 s", "há 3 min", "há 2 h". */
export function fmtRelativo(iso: string, agora = Date.now()): string {
  const s = Math.max(0, Math.round((agora - new Date(iso).getTime()) / 1000));
  if (s < 60) return `há ${s} s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

const minusculas = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'della', 'von', 'van']);
/** "FLAVIO BOLSONARO" → "Flavio Bolsonaro". Mantém siglas curtas em caixa alta. */
export function nomeProprio(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => {
      if (i > 0 && minusculas.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function iniciais(nome: string): string {
  const partes = nome
    .split(/\s+/)
    .filter((w) => w && !minusculas.has(w.toLowerCase()));
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

export const reduzMovimento = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const emCurso = new WeakMap<Element, number>();
const valorAtual = new WeakMap<Element, number>();

/**
 * Anima o texto de `el` de seu valor anterior até `para`, usando `fmt`.
 * Ignora a animação quando o usuário prefere menos movimento.
 */
export function contar(el: HTMLElement, para: number, fmt: (n: number) => string, dur = 900): void {
  const de = valorAtual.get(el);
  valorAtual.set(el, para);
  const anterior = emCurso.get(el);
  if (anterior) cancelAnimationFrame(anterior);
  if (de === undefined || de === para || reduzMovimento()) {
    el.textContent = fmt(para);
    return;
  }
  const t0 = performance.now();
  const passo = (t: number) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(de + (para - de) * e);
    if (p < 1) emCurso.set(el, requestAnimationFrame(passo));
    else emCurso.delete(el);
  };
  emCurso.set(el, requestAnimationFrame(passo));
}

/** Reinicia uma animação CSS (classe) em um elemento. */
export function pulsar(el: Element, classe = 'pulse'): void {
  el.classList.remove(classe);
  // força reflow para reiniciar a animação
  void (el as HTMLElement).offsetWidth;
  el.classList.add(classe);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style') e.setAttribute('style', String(v));
    else if (k === 'text') e.textContent = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c);
  }
  return e;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
