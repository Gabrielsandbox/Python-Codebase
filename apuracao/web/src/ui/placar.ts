// Placar principal: os dois candidatos em destaque, barra única, margem e progresso.

import { textoSobre } from '../color';
import { contar, el, fmtInt, fmtPct, fmtPP, iniciais, nomeProprio, pulsar } from '../format';
import type { Store } from '../store';
import { montarBotaoWhatsApp } from './whatsapp';

interface Lado {
  raiz: HTMLElement;
  avatar: HTMLElement;
  nome: HTMLElement;
  partido: HTMLElement;
  pct: HTMLElement;
  votos: HTMLElement;
  ribbon: HTMLElement;
  barra: HTMLElement;
}

export function montarPlacar(raiz: HTMLElement, store: Store): void {
  const kickerSecoes = el('span', { class: 'secoes num' });
  const kickerEsq = el('span', {}, el('span', { text: 'Brasil' }), kickerSecoes);
  const kickerDir = el('span', { class: 'pct-tot num' });
  const progresso = el('i');
  const contest = el('div', { class: 'contest' });
  raiz.append(
    el('div', { class: 'hero-kicker' }, kickerEsq, kickerDir),
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Seções totalizadas' }, progresso),
    contest,
  );

  let lados: Lado[] = [];
  let outrosBarra: HTMLElement | null = null;
  let margem: HTMLElement | null = null;
  let outrosLista: HTMLElement | null = null;
  let montadoPara = '';
  // compartilhar (WhatsApp) logo abaixo da barra: montado uma vez, realocado se a estrutura for refeita
  const share = montarBotaoWhatsApp(store, { outrosApps: true, pulsar: true });
  share.classList.add('hero-share');

  const lado = (dir: 'left' | 'right'): Lado => {
    const avatar = el('div', { class: 'avatar', 'aria-hidden': 'true' });
    const nome = el('div', { class: 'name' });
    const partido = el('div', { class: 'party' });
    const pct = el('span', { class: 'big' });
    const votos = el('div', { class: 'votes num' });
    const ribbon = el('span', { class: 'ribbon', text: 'Eleito', hidden: true });
    const barra = el('i');
    const raizLado = el(
      'div',
      { class: `cand ${dir}` },
      avatar,
      el('div', { class: 'who' }, nome, partido),
      el('div', { class: 'figures' }, el('div', {}, pct), votos, el('div', {}, ribbon)),
    );
    return { raiz: raizLado, avatar, nome, partido, pct, votos, ribbon, barra };
  };

  const montarEstrutura = () => {
    const chave = store.principais.join(',');
    if (chave === montadoPara) return;
    montadoPara = chave;
    contest.replaceChildren();
    lados = [lado('left'), lado('right')];
    outrosBarra = el('i', { class: 'other' });
    margem = el('div', { class: 'margin-line' });
    const barra = el('div', { class: 'race-bar', 'aria-hidden': 'true' }, lados[0].barra, outrosBarra, lados[1].barra);
    contest.append(lados[0].raiz, lados[1].raiz, barra);
    if (store.disputaDupla) contest.append(el('div', { class: 'race-mid', 'aria-hidden': 'true' }));
    contest.append(margem, share);
    if (store.meta.cands.length > 2) {
      outrosLista = el('ul');
      contest.append(
        el(
          'details',
          { class: 'others' },
          el('summary', {}, el('span', { text: `Outros ${store.meta.cands.length - 2} candidatos` })),
          outrosLista,
        ),
      );
    }
    store.principais.forEach((ci, i) => {
      const c = store.cand(ci);
      const cor = store.paleta.cores[ci];
      const L = lados[i];
      L.avatar.textContent = iniciais(c.nome);
      L.avatar.style.background = cor;
      L.avatar.style.color = textoSobre(cor);
      L.nome.textContent = nomeProprio(c.nome);
      L.partido.textContent = `${c.partido} · ${c.numero}`;
      L.barra.style.background = cor;
    });
  };

  const renderTema = () => {
    if (!lados.length) return;
    store.principais.forEach((ci, i) => {
      const cor = store.paleta.cores[ci];
      lados[i].avatar.style.background = cor;
      lados[i].avatar.style.color = textoSobre(cor);
      lados[i].barra.style.background = cor;
    });
    renderOutros();
  };

  const renderOutros = () => {
    const br = store.br;
    if (!outrosLista || !br) return;
    outrosLista.replaceChildren();
    const outros = store.ordenarPorVotos(br).filter((i) => !store.principais.includes(i));
    for (const i of outros) {
      const c = store.cand(i);
      outrosLista.append(
        el(
          'li',
          {},
          el('span', { class: 'sw', style: `background:${store.paleta.cores[i]}` }),
          el('span', { text: nomeProprio(c.nome) }),
          el('span', { class: 'p', text: c.partido }),
          el('span', { class: 'v num', text: fmtPct(br.pct[i] ?? 0) }),
        ),
      );
    }
  };

  const render = () => {
    const br = store.br;
    if (!br || !store.meta) return;
    montarEstrutura();
    kickerSecoes.textContent = ` · ${fmtInt(br.secoes.totalizadas)} de ${fmtInt(br.secoes.total)} seções`;
    kickerDir.replaceChildren(el('span', { class: 'long', text: `${fmtPct(br.secoes.pct, 1)} das seções totalizadas` }), el('span', { class: 'short', text: `${fmtPct(br.secoes.pct, 1)} das seções` }));
    progresso.style.width = `${br.secoes.pct}%`;
    progresso.parentElement!.setAttribute('aria-valuenow', String(br.secoes.pct));

    const [a, b] = store.principais;
    const pa = br.pct[a] ?? 0;
    const pb = br.pct[b] ?? 0;
    const pOutros = Math.max(0, 100 - pa - pb);
    lados.forEach((L, i) => {
      const ci = store.principais[i];
      const p = br.pct[ci] ?? 0;
      const v = br.v[ci] ?? 0;
      contar(L.pct, p, (n) => fmtPct(n));
      contar(L.votos, v, (n) => `${fmtInt(n)} votos`);
      L.barra.style.flexBasis = `${p}%`;
      const eleito = br.definido && /eleit[oa]/i.test(br.situacao[store.meta.cands[ci]] ?? '') && !/não/i.test(br.situacao[store.meta.cands[ci]] ?? '');
      L.ribbon.hidden = !eleito;
      pulsar(L.pct);
    });
    if (outrosBarra) {
      outrosBarra.style.flexBasis = `${pOutros}%`;
      outrosBarra.style.display = pOutros < 0.05 ? 'none' : '';
    }
    if (margem) {
      margem.replaceChildren();
      const liderIdx = br.lider ? store.idx(br.lider) : -1;
      if (liderIdx >= 0 && br.votos.validos > 0) {
        const nome = nomeProprio(store.cand(liderIdx).nome);
        const venceu = br.definido && /^eleit[oa]$/i.test((br.situacao[store.meta.cands[liderIdx]] ?? '').trim());
        margem.append(
          el('strong', { text: nome }),
          venceu ? ' venceu por ' : ' lidera por ',
          el('strong', { class: 'num', text: `${fmtInt(br.margem_votos)} votos` }),
          ` (${fmtPP(br.margem_pct)})`,
        );
      } else {
        margem.textContent = 'Aguardando as primeiras seções totalizadas.';
      }
    }
    renderOutros();
  };

  store.on('br', render);
  store.on('tema', renderTema);
}
