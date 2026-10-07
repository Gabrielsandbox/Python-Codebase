// Ritmo da apuração (docs/RECURSOS.md §2): indicador compacto na barra superior e
// sparkline de seções/min calculada no cliente a partir de timeline/br.json.
// É extrapolação da velocidade de contagem — nunca do resultado.

import { el, fmtHora, fmtInt, svgEl } from '../format';
import type { Store } from '../store';
import type { Ritmo, Timeline } from '../types';

export const EXPLICACAO_RITMO =
  'Velocidade de totalização nos últimos minutos (seções por minuto) e o horário estimado para 100% das seções, ' +
  'extrapolando essa velocidade. É uma estimativa do ritmo da contagem, não do resultado.';

/** "20:41" → "20h41". */
export const fmtHoraCurta = (iso: string): string => fmtHora(iso).replace(':', 'h');

export interface PontoRitmo {
  t: number;
  valor: number; // seções/min
}

/**
 * Seções/min entre pontos consecutivos da linha do tempo: Δ% × total ÷ Δmin.
 * Devolve até `n` pontos finais (ignora intervalos não positivos).
 */
export function serieRitmo(tl: Timeline | null, secoesTotal: number, n = 40): PontoRitmo[] {
  if (!tl || tl.pontos.length < 2 || secoesTotal <= 0) return [];
  const out: PontoRitmo[] = [];
  const ps = tl.pontos;
  for (let i = Math.max(1, ps.length - n); i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    const dt = (new Date(b.t).getTime() - new Date(a.t).getTime()) / 60_000;
    if (!(dt > 0)) continue;
    const dsec = ((b.secoes_pct - a.secoes_pct) / 100) * secoesTotal;
    out.push({ t: new Date(b.t).getTime(), valor: Math.max(0, dsec / dt) });
  }
  return out;
}

/** Texto curto: "812 seções/min · 100% ≈ 20h41" (ETA omitido quando null). */
export function textoRitmo(r: Ritmo): { principal: string; nota: string | null } {
  if (r.fase === 'concluida') return { principal: 'totalização concluída', nota: null };
  if (r.fase === 'aguardando' || r.secoes_por_min < 1) return { principal: 'aguardando as primeiras seções', nota: null };
  const partes = [`${fmtInt(r.secoes_por_min)} seções/min`];
  if (r.eta_100) partes.push(`100% ≈ ${fmtHoraCurta(r.eta_100)}`);
  return { principal: partes.join(' · '), nota: r.fase === 'cauda' ? 'reta final, ritmo cai' : r.fase === 'acelerando' ? 'acelerando' : null };
}

/** Sparkline (linha 2 px + ponto final com anel) em um só matiz de texto. */
export function sparkline(serie: PontoRitmo[], w = 120, h = 28): SVGSVGElement {
  const svg = svgEl('svg', { class: 'spark', viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' });
  if (serie.length < 2) return svg;
  const max = Math.max(...serie.map((p) => p.valor), 1);
  const t0 = serie[0].t;
  const t1 = serie[serie.length - 1].t;
  const pad = 4;
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const d = serie.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.valor).toFixed(1)}`).join('');
  const area = `${d}L${x(t1).toFixed(1)},${h - pad}L${x(t0).toFixed(1)},${h - pad}Z`;
  svg.append(svgEl('path', { class: 'spark-area', d: area }), svgEl('path', { class: 'spark-line', d }));
  const u = serie[serie.length - 1];
  svg.append(svgEl('circle', { class: 'spark-dot', cx: x(u.t), cy: y(u.valor), r: 3.5 }));
  return svg;
}

/** Indicador compacto na barra superior, ao lado do "ao vivo". */
export function montarRitmoIndicador(container: HTMLElement, store: Store): void {
  const txt = el('span', { class: 'rt num' });
  const nota = el('span', { class: 'nota' });
  const ind = el('span', { class: 'ritmo-ind', role: 'status', title: EXPLICACAO_RITMO, hidden: true }, el('i', { class: 'ico', 'aria-hidden': 'true' }), txt, nota);
  container.prepend(ind);
  const render = () => {
    const r = store.ritmo;
    if (!r || r.fase === 'aguardando' || r.fase === 'concluida') {
      ind.hidden = true;
      return;
    }
    const { principal, nota: n } = textoRitmo(r);
    txt.textContent = principal;
    nota.textContent = n ? `· ${n}` : '';
    nota.hidden = !n;
    ind.hidden = false;
  };
  store.on('ritmo', render);
  render();
}
