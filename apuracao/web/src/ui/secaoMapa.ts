// Seção do mapa: barra de ferramentas (migalhas, voltar, UF|Municípios), legenda,
// tooltip e painel lateral com o resultado da seleção.

import { DEGRAU_LABELS } from '../color';
import { el, fmtInt, fmtPct, fmtPP, nomeProprio } from '../format';
import { Mapa, type Alvo } from '../map/mapa';
import type { Store } from '../store';
import type { Resultado } from '../types';
import { linkFonte, urlFonteBr, urlFonteUf } from '../recursos/fonte';

export interface SecaoMapa {
  mapa: Mapa;
  mostrarCarregando: (msg: string | null) => void;
}

export function montarSecaoMapa(raiz: HTMLElement, store: Store): SecaoMapa {
  // ------------------------------------------------------------ toolbar
  const aqui = el('span', { class: 'here', text: 'Brasil' });
  const voltar = el('button', { class: 'btn', type: 'button', hidden: true }, '← Brasil');
  const segUf = el('button', { type: 'button', 'aria-pressed': 'true', text: 'Estados' });
  const segMun = el('button', { type: 'button', 'aria-pressed': 'false', text: 'Municípios' });
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Granularidade do mapa' }, el('span', { class: 'lab', text: 'Mapa' }), segUf, segMun);
  const toolbar = el('div', { class: 'map-toolbar' }, el('div', { class: 'crumbs' }, voltar, aqui), seg);

  // ------------------------------------------------------------ mapa + tooltip
  const tip = el('div', { class: 'tip', role: 'tooltip' });
  const carregando = el('div', { class: 'map-loading', hidden: true });
  const dica = el('div', { class: 'map-hint', text: 'Toque em um estado para ver os municípios' });
  let tipFixo = false;

  const esconderTip = () => {
    tip.classList.remove('on');
    tipFixo = false;
  };

  const mostrarTip = (alvo: Alvo, x: number, y: number) => {
    tip.replaceChildren(...conteudoTip(alvo));
    tip.classList.add('on');
    const W = mapa.raiz.clientWidth;
    const H = mapa.raiz.clientHeight;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + 16;
    let top = y + 16;
    if (left + tw > W - 8) left = Math.max(8, x - tw - 16);
    if (top + th > H - 8) top = Math.max(8, y - th - 16);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const linhasCandidatos = (r: { v: number[]; pct: number[] }, n: number) =>
    store
      .ordenarPorVotos(r)
      .slice(0, n)
      .map((i) =>
        el(
          'div',
          { class: 'row' },
          el('i', { class: 'k', style: `background:${store.paleta.cores[i]}` }),
          el('span', { class: 'n', text: nomeProprio(store.cand(i).nome) }),
          el('span', { class: 'v' }, fmtPct(r.pct[i] ?? 0), el('small', { text: fmtInt(r.v[i] ?? 0) })),
        ),
      );

  const conteudoTip = (alvo: Alvo): Node[] => {
    const n = store.disputaDupla ? 2 : 3;
    if (alvo.tipo === 'uf') {
      const r = store.resultadoUf(alvo.sigla);
      const head = el('div', { class: 't' }, alvo.nome, el('span', { class: 'uf', text: alvo.sigla }));
      if (!r || r.secoes.totalizadas === 0 || r.votos.validos === 0) return [head, el('div', { class: 'nd', text: 'Sem seções totalizadas ainda' })];
      return [
        head,
        el('div', { class: 's', text: `${fmtPct(r.secoes.pct, 1)} das seções · ${fmtInt(r.votos.validos)} votos válidos` }),
        ...linhasCandidatos(r, n),
      ];
    }
    const m = store.mun?.get(alvo.ibge);
    const head = el('div', { class: 't' }, store.nomeMun(alvo.ibge, alvo.nome), el('span', { class: 'uf', text: alvo.uf }));
    if (!m || m.liderIdx < 0) return [head, el('div', { class: 'nd', text: m ? 'Sem seções totalizadas ainda' : 'Dados municipais ainda não carregados' })];
    return [
      head,
      el('div', { class: 's', text: `${fmtPct(m.pctApurado, 1)} das seções · ${fmtInt(m.validos)} votos válidos` }),
      ...linhasCandidatos(m, n),
    ];
  };

  const mapa = new Mapa({
    store,
    onHover: (alvo, x, y) => {
      if (tipFixo) return;
      if (!alvo) {
        tip.classList.remove('on');
        return;
      }
      mostrarTip(alvo, x, y);
    },
    onTap: (alvo, x, y) => {
      if (alvo.tipo === 'uf') {
        esconderTip();
        store.selecionarUf(alvo.sigla);
        return;
      }
      if (!store.ufSelecionada) {
        esconderTip();
        store.selecionarUf(alvo.uf);
        return;
      }
      // dentro de um estado: toque fixa o tooltip do município
      if (tipFixo && tip.dataset.ibge === alvo.ibge) {
        esconderTip();
        return;
      }
      mostrarTip(alvo, x, y);
      tip.dataset.ibge = alvo.ibge;
      tipFixo = true;
    },
  });
  mapa.raiz.append(tip, carregando, dica);
  mapa.raiz.addEventListener('pointerleave', () => {
    if (!tipFixo) tip.classList.remove('on');
  });

  // ------------------------------------------------------------ legenda
  const legenda = el('div', { class: 'legend', 'aria-label': 'Legenda do mapa' });

  const renderLegenda = () => {
    if (!store.meta) return;
    legenda.replaceChildren();
    const extra = el(
      'div',
      { class: 'leg-extra' },
      el('span', {}, el('i', { class: 'sw hatch' }), 'sem seções totalizadas'),
      el('span', {}, el('i', { class: 'sw tie' }), 'empate'),
    );
    if (store.disputaDupla) {
      const [a, b] = [0, 1];
      const ra = store.paleta.rampas[a];
      const rb = store.paleta.rampas[b];
      const steps = el('div', { class: 'steps' });
      [...ra].reverse().forEach((c) => steps.append(el('i', { style: `background:${c}` })));
      steps.append(el('i', { style: `background:var(--map-tie)` }));
      rb.forEach((c) => steps.append(el('i', { style: `background:${c}` })));
      const ticks = el('div', { class: 'ticks' });
      [...DEGRAU_LABELS].reverse().forEach((t) => ticks.append(el('span', { text: t })));
      ticks.append(el('span', { text: '0' }));
      DEGRAU_LABELS.forEach((t) => ticks.append(el('span', { text: t })));
      legenda.append(
        el('div', { class: 'title', text: 'Vantagem do líder (pontos percentuais)' }),
        el(
          'div',
          { class: 'leg-div' },
          el(
            'div',
            { class: 'names' },
            el('span', {}, el('i', { class: 'sw', style: `background:${store.paleta.cores[a]}` }), nomeProprio(store.cand(a).nome)),
            el('span', {}, nomeProprio(store.cand(b).nome), el('i', { class: 'sw', style: `background:${store.paleta.cores[b]}` })),
          ),
          steps,
          ticks,
        ),
        extra,
      );
      return;
    }
    // vários candidatos: uma linha por líder presente nos dados
    const lideres = new Set<number>();
    if (store.uf) for (const r of Object.values(store.uf.ufs)) if (r.lider && r.secoes.totalizadas > 0) lideres.add(store.idx(r.lider));
    if (store.mun) for (const m of store.mun.values()) if (m.liderIdx >= 0) lideres.add(m.liderIdx);
    for (const i of store.principais) lideres.add(i);
    const ordem = [...lideres].filter((i) => i >= 0).sort((x, y) => (store.br?.v[y] ?? 0) - (store.br?.v[x] ?? 0));
    const rows = el('div', { class: 'leg-rows' });
    for (const i of ordem) {
      const steps = el('div', { class: 'steps' });
      store.paleta.rampas[i].forEach((c) => steps.append(el('i', { style: `background:${c}` })));
      rows.append(
        el(
          'div',
          { class: 'leg-row' },
          el('span', { class: 'who' }, el('i', { class: 'sw', style: `background:${store.paleta.cores[i]}` }), nomeProprio(store.cand(i).nome)),
          steps,
        ),
      );
    }
    const ticks = el('div', { class: 'ticks' });
    DEGRAU_LABELS.forEach((t) => ticks.append(el('span', { text: t })));
    legenda.append(
      el('div', { class: 'title', text: 'Líder e vantagem (pontos percentuais)' }),
      rows,
      el('div', { class: 'leg-ticks' }, el('span'), ticks),
      extra,
    );
  };

  // ------------------------------------------------------------ painel lateral
  const painel = el('div', { class: 'card sel-panel' });

  const renderPainel = () => {
    if (!store.meta) return;
    painel.replaceChildren();
    const sigla = store.ufSelecionada;
    let r: Resultado | null;
    let titulo: string;
    let sub: string;
    if (sigla) {
      r = store.resultadoUf(sigla);
      titulo = store.nomeUf(sigla);
      sub = sigla;
    } else {
      r = store.br;
      titulo = 'Brasil';
      sub = `${store.meta.cands.length} candidatos`;
    }
    painel.append(
      el('div', { class: 'head' }, el('h2', { text: titulo }), el('span', { class: 'sub' }, sub, ' ', linkFonte(sigla ? urlFonteUf(store, sigla) : urlFonteBr(store)))),
    );
    if (!r) {
      painel.append(el('div', { class: 'empty', text: 'Carregando…' }));
      return;
    }
    painel.append(
      el('div', { class: 'mini-progress', 'aria-hidden': 'true' }, el('i', { style: `width:${r.secoes.pct}%` })),
      el('div', { class: 'sub num', style: 'font-size:12.5px;color:var(--muted)', text: `${fmtPct(r.secoes.pct, 1)} das seções totalizadas (${fmtInt(r.secoes.totalizadas)} de ${fmtInt(r.secoes.total)})` }),
    );
    if (r.secoes.totalizadas === 0 || r.votos.validos === 0) {
      painel.append(el('div', { class: 'empty', text: 'Nenhuma seção totalizada ainda neste estado.' }));
      return;
    }
    const n = store.disputaDupla ? 2 : 4;
    const rows = el('div', { class: 'cand-rows' });
    const maxPct = Math.max(...r.pct, 1);
    for (const i of store.ordenarPorVotos(r).slice(0, n)) {
      const c = store.cand(i);
      rows.append(
        el(
          'div',
          { class: 'cand-row' },
          el('div', { class: 'who' }, el('i', { class: 'sw', style: `background:${store.paleta.cores[i]}` }), el('span', { class: 'n', text: nomeProprio(c.nome) }), el('span', { class: 'p', text: c.partido })),
          el('div', { class: 'v' }, fmtPct(r.pct[i] ?? 0), el('small', { text: fmtInt(r.v[i] ?? 0) })),
          el('div', { class: 'bar' }, el('i', { style: `width:${((r.pct[i] ?? 0) / maxPct) * 100}%;background:${store.paleta.cores[i]}` })),
        ),
      );
    }
    painel.append(rows);
    const liderIdx = r.lider ? store.idx(r.lider) : -1;
    painel.append(
      el(
        'div',
        { class: 'meta' },
        el('div', {}, 'Margem', el('b', { class: 'num', text: liderIdx >= 0 ? fmtPP(r.margem_pct) : '–' })),
        el('div', {}, 'Comparecimento', el('b', { class: 'num', text: fmtPct(r.eleitorado.pct_comparecimento, 1) })),
        el('div', {}, 'Brancos e nulos', el('b', { class: 'num', text: fmtPct(r.votos.pct_brancos + r.votos.pct_nulos, 1) })),
        el('div', {}, 'Votos válidos', el('b', { class: 'num', text: fmtInt(r.votos.validos) })),
      ),
    );
  };

  // ------------------------------------------------------------ montagem
  const card = el('div', { class: 'card map-card' }, toolbar, mapa.raiz, legenda);
  const side = el('div', { class: 'side' }, painel);
  raiz.append(card, side);

  voltar.addEventListener('click', () => store.selecionarUf(null));
  segUf.addEventListener('click', () => store.setGranularidade('uf'));
  segMun.addEventListener('click', () => store.setGranularidade('mun'));

  const renderToolbar = () => {
    const sigla = store.ufSelecionada;
    aqui.textContent = sigla ? store.nomeUf(sigla) : 'Brasil';
    voltar.hidden = !sigla;
    seg.style.display = sigla ? 'none' : '';
    dica.textContent = sigla ? 'Toque em um município para ver os votos' : store.granularidade === 'mun' ? 'Toque em um município para ampliar o estado' : 'Toque em um estado para ver os municípios';
    segUf.setAttribute('aria-pressed', String(store.granularidade === 'uf'));
    segMun.setAttribute('aria-pressed', String(store.granularidade === 'mun'));
  };

  store.on('selecao', () => {
    esconderTip();
    mapa.irPara(store.ufSelecionada);
    renderToolbar();
    renderPainel();
  });
  store.on('granularidade', () => {
    esconderTip();
    mapa.invalidarPick();
    mapa.render();
    renderToolbar();
  });
  store.on(['uf', 'mun', 'br'], () => {
    mapa.render();
    renderPainel();
  });
  store.on(['meta', 'uf', 'mun', 'tema'], renderLegenda);
  store.on('tema', () => {
    mapa.lerCores();
    mapa.render();
    renderPainel();
  });
  renderToolbar();

  return {
    mapa,
    mostrarCarregando: (msg) => {
      carregando.hidden = !msg;
      carregando.textContent = msg ?? '';
    },
  };
}
