// Gráfico de linhas: % de votos válidos por candidato ao longo da totalização.
// Só aparece com ≥ 2 pontos. Crosshair + tooltip com todas as séries.

import { el, fmtHora, fmtHoraSeg, fmtPct, nomeProprio, svgEl } from '../format';
import type { Store } from '../store';

const M = { top: 14, right: 70, bottom: 26, left: 36 };
const H = 240;

export function montarLinha(raiz: HTMLElement, store: Store): void {
  const svg = svgEl('svg', { height: H, role: 'img', 'aria-label': 'Evolução do percentual de votos válidos por candidato' });
  const legenda = el('div', { class: 'chart-legend' });
  const tip = el('div', { class: 'tip' });
  const wrap = el('div', { class: 'chart-wrap' }, el('div', { class: 'chart' }, svg), tip);
  const card = el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Evolução da totalização' }), el('span', { class: 'sub', text: '% dos votos válidos · Brasil' })),
    legenda,
    wrap,
  );
  card.hidden = true;
  raiz.append(card);

  let largura = 0;
  new ResizeObserver((es) => {
    const w = es[0].contentRect.width;
    if (Math.abs(w - largura) > 1) {
      largura = w;
      render();
    }
  }).observe(wrap);

  const render = () => {
    const tl = store.timeline;
    if (!tl || tl.pontos.length < 2 || !store.meta) {
      card.hidden = true;
      raiz.hidden = true;
      return;
    }
    card.hidden = false;
    raiz.hidden = false;
    if (largura === 0) largura = wrap.getBoundingClientRect().width;
    if (largura === 0) return;
    const W = largura;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.replaceChildren();

    const series = store.principais.length ? [...store.principais] : [0, 1];
    // até 4 séries: principais + 2 maiores restantes (se houver)
    if (store.br && store.meta.cands.length > 2) {
      for (const i of store.ordenarPorVotos(store.br)) {
        if (series.length >= 4) break;
        if (!series.includes(i)) series.push(i);
      }
    }
    const pontos = tl.pontos;
    const ts = pontos.map((p) => new Date(p.t).getTime());
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    const x = (t: number) => M.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - M.left - M.right);
    let ymin = 100;
    let ymax = 0;
    for (const p of pontos) for (const s of series) {
      const v = p.pct[s] ?? 0;
      ymin = Math.min(ymin, v);
      ymax = Math.max(ymax, v);
    }
    const passo = ymax - ymin > 40 ? 20 : ymax - ymin > 15 ? 10 : 5;
    ymin = Math.max(0, Math.floor((ymin - 2) / passo) * passo);
    ymax = Math.min(100, Math.ceil((ymax + 2) / passo) * passo);
    const y = (v: number) => M.top + (1 - (v - ymin) / Math.max(1, ymax - ymin)) * (H - M.top - M.bottom);

    const grid = svgEl('g', { class: 'grid' });
    const axis = svgEl('g', { class: 'axis' });
    for (let v = ymin; v <= ymax + 1e-6; v += passo) {
      grid.append(svgEl('line', { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }));
      const t = svgEl('text', { x: M.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' });
      t.textContent = `${v}%`;
      axis.append(t);
    }
    const nTicks = Math.max(2, Math.min(6, Math.floor((W - M.left - M.right) / 90)));
    const curto = t1 - t0 < 10 * 60_000;
    const vistos = new Set<string>();
    for (let i = 0; i < nTicks; i++) {
      const t = t0 + ((t1 - t0) * i) / (nTicks - 1);
      const iso = new Date(t).toISOString();
      const rotulo = curto ? fmtHoraSeg(iso) : fmtHora(iso);
      if (vistos.has(rotulo)) continue;
      vistos.add(rotulo);
      const tx = svgEl('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle' });
      tx.textContent = rotulo;
      axis.append(tx);
    }
    svg.append(grid, axis);

    const gS = svgEl('g', { class: 'series' });
    const ultimos: { s: number; y: number; cor: string; txt: string }[] = [];
    for (const s of series) {
      const cor = store.paleta.cores[s];
      const d = pontos.map((p, i) => `${i ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(p.pct[s] ?? 0).toFixed(1)}`).join('');
      gS.append(svgEl('path', { d, stroke: cor }));
      const u = pontos[pontos.length - 1];
      gS.append(svgEl('circle', { cx: x(ts[ts.length - 1]), cy: y(u.pct[s] ?? 0), r: 4, fill: cor }));
      ultimos.push({ s, y: y(u.pct[s] ?? 0), cor, txt: fmtPct(u.pct[s] ?? 0, 1) });
    }
    svg.append(gS);
    // rótulos finais (evita colisão: separa 14px)
    ultimos.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ultimos.length; i++) if (ultimos[i].y - ultimos[i - 1].y < 14) ultimos[i].y = ultimos[i - 1].y + 14;
    for (const u of ultimos) {
      const t = svgEl('text', { class: 'end-label', x: W - M.right + 8, y: u.y + 4 });
      t.textContent = u.txt;
      svg.append(t);
    }

    legenda.replaceChildren(
      ...series.map((s) =>
        el('span', {}, el('i', { style: `background:${store.paleta.cores[s]}` }), nomeProprio(store.cand(s).nome)),
      ),
    );

    // hover
    const xhair = svgEl('line', { class: 'xhair', y1: M.top, y2: H - M.bottom, x1: -10, x2: -10 });
    const dots = svgEl('g', { class: 'series' });
    const hit = svgEl('rect', { x: M.left, y: 0, width: Math.max(0, W - M.left - M.right), height: H, fill: 'transparent' });
    svg.append(xhair, dots, hit);
    const mostrar = (clientX: number) => {
      const r = svg.getBoundingClientRect();
      const px = clientX - r.left;
      let melhor = 0;
      let dist = Infinity;
      ts.forEach((t, i) => {
        const dd = Math.abs(x(t) - px);
        if (dd < dist) {
          dist = dd;
          melhor = i;
        }
      });
      const p = pontos[melhor];
      const xx = x(ts[melhor]);
      xhair.setAttribute('x1', String(xx));
      xhair.setAttribute('x2', String(xx));
      dots.replaceChildren(...series.map((s) => svgEl('circle', { cx: xx, cy: y(p.pct[s] ?? 0), r: 4.5, fill: store.paleta.cores[s] })));
      tip.replaceChildren(
        el('div', { class: 't' }, fmtHoraSeg(p.t)),
        el('div', { class: 's', text: `${fmtPct(p.secoes_pct, 1)} das seções totalizadas` }),
        ...series.map((s) =>
          el(
            'div',
            { class: 'row' },
            el('i', { class: 'k', style: `background:${store.paleta.cores[s]}` }),
            el('span', { class: 'n', text: nomeProprio(store.cand(s).nome) }),
            el('span', { class: 'v', text: fmtPct(p.pct[s] ?? 0) }),
          ),
        ),
      );
      tip.classList.add('on');
      const tw = tip.offsetWidth;
      const left = xx + 14 + tw > W ? xx - tw - 14 : xx + 14;
      tip.style.left = `${left}px`;
      tip.style.top = `${M.top}px`;
    };
    const esconder = () => {
      tip.classList.remove('on');
      xhair.setAttribute('x1', '-10');
      xhair.setAttribute('x2', '-10');
      dots.replaceChildren();
    };
    hit.addEventListener('pointermove', (e) => mostrar(e.clientX));
    hit.addEventListener('pointerdown', (e) => mostrar(e.clientX));
    hit.addEventListener('pointerleave', esconder);
  };

  store.on(['timeline', 'tema', 'br'], render);
}
