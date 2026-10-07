// Tiles de totais nacionais: eleitorado, comparecimento, abstenção, válidos, brancos, nulos.

import { contar, el, fmtInt, fmtPct } from '../format';
import type { Store } from '../store';

export function montarTotais(raiz: HTMLElement, store: Store): void {
  const tiles = el('div', { class: 'tiles' });
  raiz.append(tiles);
  const defs: { chave: string; rotulo: string }[] = [
    { chave: 'aptos', rotulo: 'Eleitores aptos' },
    { chave: 'comparecimento', rotulo: 'Comparecimento' },
    { chave: 'abstencao', rotulo: 'Abstenção' },
    { chave: 'validos', rotulo: 'Votos válidos' },
    { chave: 'brancos', rotulo: 'Brancos' },
    { chave: 'nulos', rotulo: 'Nulos' },
  ];
  const refs = new Map<string, { v: HTMLElement; d: HTMLElement }>();
  for (const d of defs) {
    const v = el('div', { class: 'v' });
    const det = el('div', { class: 'd num' });
    refs.set(d.chave, { v, d: det });
    tiles.append(el('div', { class: 'card tile' }, el('div', { class: 'l', text: d.rotulo }), v, det));
  }

  const render = () => {
    const br = store.br;
    if (!br) return;
    const e = br.eleitorado;
    const vt = br.votos;
    const set = (k: string, valor: number, detalhe: string) => {
      const r = refs.get(k)!;
      contar(r.v, valor, fmtInt);
      r.d.textContent = detalhe;
    };
    set('aptos', e.aptos, 'eleitorado total');
    set('comparecimento', e.comparecimento, `${fmtPct(e.pct_comparecimento)} dos aptos`);
    set('abstencao', e.abstencao, `${fmtPct(e.pct_abstencao)} dos aptos`);
    set('validos', vt.validos, `${fmtPct(vt.pct_validos)} dos votos`);
    set('brancos', vt.brancos, `${fmtPct(vt.pct_brancos)} dos votos`);
    set('nulos', vt.nulos, `${fmtPct(vt.pct_nulos)} dos votos`);
  };
  store.on('br', render);
}
