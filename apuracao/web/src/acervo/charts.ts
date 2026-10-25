// Gráficos em SVG puro: barras horizontais (identidade por partido) e linhas (pesquisas).
// Marcas finas, rótulos em cor de texto (nunca na cor da série), tooltip ao passar o mouse e
// legenda quando há 2+ séries. A tabela equivalente fica ao lado de cada gráfico (acessibilidade).
import { el, svgEl } from '../format';

const svgTxt = (attrs: Record<string, string | number>, texto: string) => {
  const t = svgEl('text', attrs);
  t.textContent = texto;
  return t;
};

export const fmtInt = (n: number) => n.toLocaleString('pt-BR');
export const fmtPct = (n: number, d = 1) => n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%';

let tooltip: HTMLElement | null = null;
function tip(): HTMLElement {
  if (!tooltip) {
    tooltip = el('div', { class: 'ch-tip', role: 'tooltip', hidden: true });
    document.body.append(tooltip);
  }
  return tooltip;
}
export function mostrarTip(x: number, y: number, html: string): void {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.min(x + 12, window.innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  t.style.transform = `translate(${Math.max(8, left)}px, ${top}px)`;
}
export function esconderTip(): void {
  if (tooltip) tooltip.hidden = true;
}

export interface Barra {
  rotulo: string;
  sub?: string;
  valor: number;
  pct?: number | null;
  cor: string;
  destaque?: boolean;
}

/** Barras horizontais, uma por candidato: nome + partido à esquerda, barra fina, valor à direita. */
export function barrasHorizontais(raiz: HTMLElement, barras: Barra[], opts: { max?: number; formato?: (b: Barra) => string } = {}): void {
  raiz.replaceChildren();
  if (!barras.length) return;
  const max = opts.max ?? Math.max(...barras.map((b) => b.valor), 1);
  const fmt = opts.formato ?? ((b: Barra) => (b.pct != null ? `${fmtPct(b.pct)} · ${fmtInt(b.valor)}` : fmtInt(b.valor)));
  const lista = el('div', { class: 'ch-barras', role: 'list' });
  for (const b of barras) {
    const w = Math.max(0.5, (100 * b.valor) / max);
    const linha = el(
      'div',
      { class: `ch-barra${b.destaque ? ' destaque' : ''}`, role: 'listitem' },
      el('div', { class: 'ch-barra-rot' }, el('i', { class: 'ch-sw', style: `background:${b.cor}`, 'aria-hidden': 'true' }), el('b', { text: b.rotulo }), b.sub ? el('span', { class: 'ch-sub', text: b.sub }) : null),
      el('div', { class: 'ch-barra-trilha', 'aria-hidden': 'true' }, el('i', { style: `width:${w}%;background:${b.cor}` })),
      el('div', { class: 'ch-barra-val num', text: fmt(b) }),
    );
    linha.addEventListener('mousemove', (e) => mostrarTip(e.clientX, e.clientY, `<b>${esc(b.rotulo)}</b>${b.sub ? ' · ' + esc(b.sub) : ''}<br>${esc(fmt(b))}`));
    linha.addEventListener('mouseleave', esconderTip);
    lista.append(linha);
  }
  raiz.append(lista);
}

export interface Serie {
  nome: string;
  cor: string;
  pontos: Array<{ x: Date; y: number; extra?: string }>;
}

/** Linhas (2 px) com marcadores (8 px), eixo y em %, crosshair + tooltip com todas as séries na data. */
export function linhas(raiz: HTMLElement, series: Serie[], opts: { yMax?: number; altura?: number } = {}): void {
  raiz.replaceChildren();
  const todas = series.flatMap((s) => s.pontos);
  if (!todas.length) return;
  const W = Math.max(320, raiz.clientWidth || 640);
  const H = opts.altura ?? 300;
  const m = { t: 16, r: 16, b: 34, l: 40 };
  const xs = todas.map((p) => p.x.getTime());
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const yMax = opts.yMax ?? Math.min(100, Math.ceil((Math.max(...todas.map((p) => p.y)) + 5) / 10) * 10);
  const X = (t: number) => m.l + ((W - m.l - m.r) * (t - x0)) / Math.max(1, x1 - x0);
  const Y = (v: number) => m.t + (H - m.t - m.b) * (1 - v / yMax);

  const svg = svgEl('svg', { class: 'ch-linhas', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Evolução das pesquisas' });
  // grade recessiva + eixo y
  for (let v = 0; v <= yMax; v += yMax <= 50 ? 10 : 20) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'ch-grid' }));
    svg.append(svgTxt({ x: m.l - 6, y: Y(v) + 4, class: 'ch-axis', 'text-anchor': 'end' }, String(v) + '%'));
  }
  // eixo x: até 6 datas
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = x0 + ((x1 - x0) * i) / n;
    svg.append(svgTxt({ x: X(t), y: H - 10, class: 'ch-axis', 'text-anchor': i === 0 ? 'start' : i === n ? 'end' : 'middle' }, fmtData(new Date(t))));
  }
  for (const s of series) {
    const pts = [...s.pontos].sort((a, b) => a.x.getTime() - b.x.getTime());
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x.getTime()).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    svg.append(svgEl('path', { d, fill: 'none', stroke: s.cor, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const p of pts) svg.append(svgEl('circle', { cx: X(p.x.getTime()), cy: Y(p.y), r: 4, fill: s.cor, class: 'ch-marker' }));
  }
  // crosshair
  const cross = svgEl('line', { y1: m.t, y2: H - m.b, class: 'ch-cross', visibility: 'hidden' });
  svg.append(cross);
  const alvo = svgEl('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  svg.append(alvo);
  const datas = [...new Set(xs)].sort((a, b) => a - b);
  alvo.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W; // coordenada no viewBox
    const t = x0 + Math.min(1, Math.max(0, (px - m.l) / Math.max(1, W - m.l - m.r))) * (x1 - x0);
    let melhor = datas[0];
    for (const d of datas) if (Math.abs(d - t) < Math.abs(melhor - t)) melhor = d;
    cross.setAttribute('x1', String(X(melhor)));
    cross.setAttribute('x2', String(X(melhor)));
    cross.setAttribute('visibility', 'visible');
    const linhasTip = series
      .map((s) => ({ s, p: s.pontos.find((p) => p.x.getTime() === melhor) }))
      .filter((o) => o.p)
      .sort((a, b) => b.p!.y - a.p!.y)
      .map((o) => `<span class="ch-tip-row"><i style="background:${o.s.cor}"></i>${esc(o.s.nome)} <b>${fmtPct(o.p!.y)}</b>${o.p!.extra ? ` <small>${esc(o.p!.extra)}</small>` : ''}</span>`)
      .join('');
    mostrarTip(e.clientX, e.clientY, `<b>${fmtData(new Date(melhor))}</b>${linhasTip}`);
  });
  alvo.addEventListener('mouseleave', () => {
    cross.setAttribute('visibility', 'hidden');
    esconderTip();
  });
  raiz.append(svg);
  // legenda (sempre, para 2+ séries)
  if (series.length >= 2) {
    raiz.append(el('div', { class: 'ch-legenda' }, ...series.map((s) => el('span', { class: 'ch-leg' }, el('i', { style: `background:${s.cor}`, 'aria-hidden': 'true' }), s.nome))));
  }
}

export const fmtData = (d: Date) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
