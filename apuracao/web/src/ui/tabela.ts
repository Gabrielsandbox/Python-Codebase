// Tabela compacta e ordenável de todas as UFs (+ exterior).

import { el, fmtPct, nomeProprio } from '../format';
import type { Store } from '../store';
import { linkFonte, urlFonteUf } from '../recursos/fonte';

type Coluna = { id: string; rotulo: string; num: boolean; cand?: number; swatch?: string };

export function montarTabela(raiz: HTMLElement, store: Store, onUf: (sigla: string) => void, onHover: (sigla: string | null) => void): void {
  const thead = el('thead');
  const tbody = el('tbody');
  const tabela = el('table', { class: 'uf' }, thead, tbody);
  const card = el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', { text: 'Por estado' }), el('span', { class: 'sub', text: '% sobre votos válidos · toque para ver no mapa' })),
    el('div', { class: 'tbl-wrap' }, tabela),
  );
  raiz.append(card);

  let ordem = { col: 'nome', asc: true };
  let colunas: Coluna[] = [];
  let candsTabela: number[] = [];

  const montarCabecalho = () => {
    if (!store.br) return;
    const n = store.meta.cands.length;
    candsTabela = n <= 3 ? store.meta.cands.map((_, i) => i) : store.ordenarPorVotos(store.br).slice(0, 3);
    // mantém a ordem dos principais à esquerda
    candsTabela.sort((a, b) => {
      const ia = store.principais.indexOf(a);
      const ib = store.principais.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    colunas = [
      { id: 'nome', rotulo: 'Estado', num: false },
      { id: 'apurado', rotulo: 'Apurado', num: true },
      ...candsTabela.map((ci) => ({
        id: `c${ci}`,
        rotulo: nomeProprio(store.cand(ci).nome).split(' ').slice(0, 2).join(' '),
        num: true,
        cand: ci,
        swatch: store.paleta.cores[ci],
      })),
      { id: 'margem', rotulo: 'Margem', num: true },
      { id: 'lider', rotulo: 'Líder', num: false },
    ];
    thead.replaceChildren(
      el(
        'tr',
        {},
        ...colunas.map((c) => {
          const btn = el('button', { type: 'button' }, c.swatch ? el('i', { class: 'sw', style: `background:${c.swatch}` }) : '', c.rotulo);
          btn.addEventListener('click', () => {
            if (ordem.col === c.id) ordem.asc = !ordem.asc;
            else ordem = { col: c.id, asc: !c.num };
            renderCorpo();
          });
          return el('th', { class: c.num ? '' : 'l', scope: 'col' }, btn);
        }),
      ),
    );
  };

  const valor = (sigla: string, col: string): number | string => {
    const r = store.uf!.ufs[sigla];
    if (col === 'nome') return r.nome;
    if (col === 'apurado') return r.secoes.pct;
    if (col === 'margem') return r.margem_pct;
    if (col === 'lider') return r.lider ? nomeProprio(store.cand(store.idx(r.lider)).nome) : '';
    if (col.startsWith('c')) return r.pct[Number(col.slice(1))] ?? 0;
    return 0;
  };

  const renderCorpo = () => {
    const uf = store.uf;
    if (!uf || !store.br) return;
    if (colunas.length === 0) montarCabecalho();
    for (const th of thead.querySelectorAll('th')) th.removeAttribute('aria-sort');
    const idx = colunas.findIndex((c) => c.id === ordem.col);
    if (idx >= 0) thead.querySelectorAll('th')[idx].setAttribute('aria-sort', ordem.asc ? 'ascending' : 'descending');

    const siglas = Object.keys(uf.ufs).sort((a, b) => {
      const va = valor(a, ordem.col);
      const vb = valor(b, ordem.col);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
      return ordem.asc ? cmp : -cmp;
    });

    tbody.replaceChildren(
      ...siglas.map((sigla) => {
        const r = uf.ufs[sigla];
        const semDados = r.secoes.totalizadas === 0 || r.votos.validos === 0;
        const liderIdx = r.lider && !semDados ? store.idx(r.lider) : -1;
        const tr = el(
          'tr',
          { tabindex: 0, 'data-uf': sigla },
          el('td', { class: 'uf-name l' }, r.nome, el('small', { text: sigla }), linkFonte(urlFonteUf(store, sigla), { icone: true })),
          el(
            'td',
            { class: 'num' },
            el('span', { class: 'pbar', 'aria-hidden': 'true' }, el('i', { style: `width:${r.secoes.pct}%` })),
            fmtPct(r.secoes.pct, 1),
          ),
          ...candsTabela.map((ci) => el('td', { class: `num ${semDados ? 'dim' : ''}`, text: semDados ? '–' : fmtPct(r.pct[ci] ?? 0) })),
          el('td', { class: `num ${semDados ? 'dim' : ''}`, text: semDados ? '–' : fmtPct(r.margem_pct, 1).replace('%', ' p.p.') }),
          el(
            'td',
            { class: 'l' },
            liderIdx >= 0
              ? el(
                  'span',
                  { class: 'lead' },
                  el('i', { class: 'sw', style: `background:${store.paleta.cores[liderIdx]}` }),
                  nomeProprio(store.cand(liderIdx).nome).split(' ')[0],
                )
              : el('span', { class: 'lead lw', text: 'sem dados' }),
          ),
        );
        if (sigla !== 'ZZ') {
          tr.addEventListener('click', () => onUf(sigla));
          tr.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onUf(sigla);
            }
          });
          tr.addEventListener('pointerenter', () => onHover(sigla));
          tr.addEventListener('pointerleave', () => onHover(null));
        } else tr.style.cursor = 'default';
        return tr;
      }),
    );
  };

  store.on(['uf', 'br'], renderCorpo);
  store.on('tema', () => {
    colunas = [];
    renderCorpo();
  });
}
