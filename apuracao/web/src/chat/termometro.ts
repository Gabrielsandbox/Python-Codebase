// Termômetro da torcida (docs/CHAT.md › Extensões): barra dividida com as cores dos
// finalistas, atualizada a cada mensagem `termometro`. É só a torcida de quem está no
// chat (não é pesquisa nem previsão) — a legenda deixa isso explícito.

import { el, fmtInt, fmtPct } from '../format';
import type { MsgTermometro } from './client';
import type { Torcida } from './reacoes';

export interface Termometro {
  raiz: HTMLElement;
  setCandidatos(c: Torcida[]): void;
  atualizar(m: MsgTermometro): void;
  /** Esconde e zera (troca de sala). */
  limpar(): void;
}

export function montarTermometro(): Termometro {
  const barra = el('div', { class: 'termo-bar' });
  const legenda = el('div', { class: 'termo-legenda' });
  const total = el('span', { class: 'termo-total num' });
  const raiz = el(
    'section',
    { class: 'chat-termo', hidden: true, 'aria-label': 'Termômetro da torcida do chat' },
    el('div', { class: 'termo-head' }, el('span', { class: 'termo-titulo', text: 'Termômetro da torcida' }), total),
    barra,
    legenda,
    el('p', { class: 'termo-nota', text: 'Só quem está no chat, nos últimos 5 min. Não é pesquisa nem resultado.' }),
  );

  let cands: Torcida[] = [];
  let ultimo: MsgTermometro | null = null;
  const segs = new Map<string, HTMLElement>();
  const pcts = new Map<string, HTMLElement>();
  const outros = el('i', { class: 'seg seg-outros', style: 'flex-basis:0%' });

  const montarEstrutura = () => {
    barra.replaceChildren();
    legenda.replaceChildren();
    segs.clear();
    pcts.clear();
    cands.forEach((c, i) => {
      const seg = el('i', { class: 'seg', style: `--cor:${c.cor};flex-basis:0%` });
      segs.set(c.id, seg);
      barra.append(seg);
      const pct = el('b', { class: 'num', text: '—' });
      pcts.set(c.id, pct);
      legenda.append(el('span', { class: `termo-item${i === cands.length - 1 ? ' fim' : ''}`, style: `--cor:${c.cor}` }, el('i', { class: 'sw', 'aria-hidden': 'true' }), el('span', { class: 'nm', text: c.nome }), pct));
    });
    barra.append(outros);
  };

  const render = () => {
    const m = ultimo;
    if (!m || !cands.length || !(m.total > 0)) {
      raiz.hidden = true;
      return;
    }
    const soma = Object.values(m.torcida).reduce((s, n) => s + (n > 0 ? n : 0), 0) || m.total;
    let acumulado = 0;
    const partes: string[] = [];
    for (const c of cands) {
      const n = Math.max(0, m.torcida[c.id] ?? 0);
      const p = (n / soma) * 100;
      acumulado += n;
      segs.get(c.id)!.style.flexBasis = `${p.toFixed(2)}%`;
      pcts.get(c.id)!.textContent = fmtPct(p, 1);
      partes.push(`${c.nome} ${fmtPct(p, 1)}`);
    }
    outros.style.flexBasis = `${(((soma - acumulado) / soma) * 100).toFixed(2)}%`;
    total.textContent = `${fmtInt(m.total)} ${m.total === 1 ? 'reação' : 'reações'} · ${m.janela_min || 5} min`;
    raiz.setAttribute('aria-label', `Termômetro da torcida do chat nos últimos ${m.janela_min || 5} minutos: ${partes.join(', ')} (${fmtInt(m.total)} reações)`);
    raiz.hidden = false;
  };

  montarEstrutura();
  return {
    raiz,
    setCandidatos(c) {
      cands = c;
      montarEstrutura();
      render();
    },
    atualizar(m) {
      if (!m || typeof m !== 'object' || typeof m.total !== 'number' || !m.torcida) return;
      ultimo = m;
      render();
    },
    limpar() {
      ultimo = null;
      render();
    },
  };
}
