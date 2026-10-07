// Modo telão (docs/RECURSOS.md §5): overlay em tela cheia, fundo escuro, placar gigante,
// mapa por UF com carrossel automático dos estados (12 s), rodapé com ritmo e caminho.
// Sem chat, sem rolagem. Esc ou o botão sai e restaura a página. Reusa o Store; o mapa é
// uma segunda instância de `Mapa`.

import type { Topology } from 'topojson-specification';
import { textoSobre } from '../color';
import { el, fmtDataLonga, fmtHoraSeg, fmtInt, fmtPct, fmtPP, iniciais, nomeProprio } from '../format';
import { Mapa } from '../map/mapa';
import type { Store } from '../store';
import { aplicarTema, lerTema } from '../tema';
import { resumoCaminho } from './caminho';
import { EXPLICACAO_RITMO, textoRitmo } from './ritmo';

export interface TelaoApi {
  abrir(opts?: { fullscreen?: boolean }): void;
  fechar(): void;
  readonly aberto: boolean;
}

const INTERVALO_CARROSSEL = 12_000;

export function montarTelao(store: Store, topoUf: () => Promise<Topology>): TelaoApi {
  let overlay: HTMLElement | null = null;
  let aberto = false;
  let pediuFullscreen = false;
  let timer: number | null = null;
  let relogio: number | null = null;
  let idx = 0;
  let mapa: Mapa | null = null;
  let geoCarregada = false;

  // ------------------------------------------------------------- DOM (construído uma vez)
  const brand = el('div', { class: 'tl-brand' });
  const hora = el('div', { class: 'tl-hora num' });
  const live = el('div', { class: 'tl-live' }, el('i', { class: 'dot' }), el('span', { text: 'ao vivo' }));
  const sair = el('button', { class: 'tl-sair', type: 'button', 'aria-label': 'Sair do modo telão (Esc)' }, 'Sair ', el('kbd', { text: 'Esc' }));
  const cands = el('div', { class: 'tl-cands' });
  const barra = el('div', { class: 'tl-race', 'aria-hidden': 'true' });
  const margem = el('div', { class: 'tl-margem' });
  const secPct = el('div', { class: 'tl-sec-pct' });
  const secBar = el('i');
  const secTxt = el('div', { class: 'tl-sec-txt' });
  const ufCard = el('div', { class: 'tl-uf', 'aria-live': 'off' });
  const dots = el('div', { class: 'tl-dots', 'aria-hidden': 'true' });
  const footRitmo = el('div', { class: 'tl-foot-item', title: EXPLICACAO_RITMO });
  const footCaminho = el('div', { class: 'tl-foot-item' });
  const mapStage = el('div', { class: 'tl-mapa' });

  const construir = () => {
    overlay = el(
      'div',
      { class: 'telao', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Modo telão' },
      el('header', { class: 'tl-top' }, brand, el('div', { class: 'tl-top-r' }, live, hora, sair)),
      el(
        'main',
        { class: 'tl-main' },
        el(
          'section',
          { class: 'tl-placar' },
          cands,
          barra,
          margem,
          el('div', { class: 'tl-secoes' }, secPct, el('div', { class: 'tl-sec-bar', 'aria-hidden': 'true' }, secBar), secTxt),
        ),
        el('section', { class: 'tl-geo' }, mapStage, ufCard, dots),
      ),
      el(
        'footer',
        { class: 'tl-foot' },
        footRitmo,
        footCaminho,
        el('div', { class: 'tl-foot-item fonte', text: 'Fonte: TSE · dados oficiais, sem projeções' }),
      ),
    );
    sair.addEventListener('click', () => fechar());
    document.body.append(overlay);
    mapa = new Mapa({
      store,
      onHover: () => {},
      onTap: (alvo) => {
        if (alvo.tipo !== 'uf') return;
        const i = siglas().indexOf(alvo.sigla);
        if (i >= 0) irPara(i, true);
      },
    });
    mapa.raiz.classList.add('tl-stage');
    mapStage.append(mapa.raiz);
  };

  // ------------------------------------------------------------- render
  const siglas = (): string[] =>
    Object.keys(store.uf?.ufs ?? {})
      .filter((s) => s !== 'ZZ')
      .sort((a, b) => store.nomeUf(a).localeCompare(store.nomeUf(b), 'pt-BR'));

  const renderTopo = () => {
    const m = store.meta;
    if (!m) return;
    brand.replaceChildren(el('b', { text: `Apuração ${m.data_eleicao.slice(0, 4)}` }), el('span', { text: `${m.turno}º turno · ${m.cargo_nome} · ${fmtDataLonga(m.data_eleicao)}` }));
    const br = store.br;
    hora.textContent = br ? `TSE ${fmtHoraSeg(br.atualizado_em)}` : '';
    live.classList.toggle('done', !!br && br.secoes.pct >= 100);
    (live.lastElementChild as HTMLElement).textContent = br && br.secoes.pct >= 100 ? 'concluída' : 'ao vivo';
  };

  const renderPlacar = () => {
    const br = store.br;
    if (!br || !store.meta || store.principais.length < 2) return;
    const [a, b] = store.principais;
    cands.replaceChildren(
      ...[a, b].map((i, k) => {
        const c = store.cand(i);
        const cor = store.paleta.cores[i];
        const eleito = br.definido && /^eleit[oa]$/i.test((br.situacao[store.meta.cands[i]] ?? '').trim());
        return el(
          'div',
          { class: `tl-cand ${k ? 'r' : 'l'}` },
          el('div', { class: 'av', style: `background:${cor};color:${textoSobre(cor)}`, text: iniciais(c.nome) }),
          el('div', { class: 'who' }, el('div', { class: 'n', text: nomeProprio(c.nome) }), el('div', { class: 'p', text: `${c.partido} · ${c.numero}` })),
          el('div', { class: 'pct', text: fmtPct(br.pct[i] ?? 0) }),
          el('div', { class: 'v num', text: `${fmtInt(br.v[i] ?? 0)} votos` }),
          eleito ? el('span', { class: 'ribbon', text: 'Eleito' }) : null,
        );
      }),
    );
    const pa = br.pct[a] ?? 0;
    const pb = br.pct[b] ?? 0;
    const outros = Math.max(0, 100 - pa - pb);
    barra.replaceChildren(
      el('i', { style: `flex-basis:${pa}%;background:${store.paleta.cores[a]}` }),
      el('i', { style: `flex-basis:${pb}%;background:${store.paleta.cores[b]}` }),
      el('span', { class: 'mid' }),
    );
    if (outros >= 0.05) barra.insertBefore(el('i', { class: 'other', style: `flex-basis:${outros}%` }), barra.children[1]);
    const liderIdx = br.lider ? store.idx(br.lider) : -1;
    if (liderIdx >= 0 && br.votos.validos > 0) {
      const venceu = br.definido && /^eleit[oa]$/i.test((br.situacao[store.meta.cands[liderIdx]] ?? '').trim());
      margem.replaceChildren(el('strong', { text: nomeProprio(store.cand(liderIdx).nome) }), venceu ? ' venceu por ' : ' lidera por ', el('strong', { class: 'num', text: `${fmtInt(br.margem_votos)} votos` }), ` (${fmtPP(br.margem_pct)})`);
    } else margem.textContent = 'Aguardando as primeiras seções totalizadas.';
    secPct.textContent = fmtPct(br.secoes.pct, 1);
    secBar.style.width = `${br.secoes.pct}%`;
    secTxt.textContent = `das seções totalizadas · ${fmtInt(br.secoes.totalizadas)} de ${fmtInt(br.secoes.total)}`;
  };

  const renderUf = () => {
    const lista = siglas();
    if (!lista.length || !store.uf) {
      ufCard.replaceChildren();
      return;
    }
    idx = ((idx % lista.length) + lista.length) % lista.length;
    const sigla = lista[idx];
    const r = store.uf.ufs[sigla];
    const semDados = r.secoes.totalizadas === 0 || r.votos.validos === 0;
    const [a, b] = store.principais;
    const ordem = [a, b].sort((x, y) => (r.v[y] ?? 0) - (r.v[x] ?? 0));
    ufCard.replaceChildren(
      el('div', { class: 'h' }, el('b', { text: r.nome }), el('span', { class: 'sg', text: sigla })),
      el('div', { class: 's num', text: semDados ? 'sem seções totalizadas' : `${fmtPct(r.secoes.pct, 1)} das seções` }),
      ...(semDados
        ? []
        : ordem.map((i) =>
            el(
              'div',
              { class: 'row' },
              el('i', { class: 'sw', style: `background:${store.paleta.cores[i]}` }),
              el('span', { class: 'n', text: nomeProprio(store.cand(i).nome).split(' ').slice(0, 2).join(' ') }),
              el('span', { class: 'v num', text: fmtPct(r.pct[i] ?? 0, 1) }),
            ),
          )),
    );
    dots.replaceChildren(...lista.map((_, i) => el('i', { class: i === idx ? 'on' : '' })));
    mapa?.realcarUf(sigla);
  };

  const renderFoot = () => {
    const rt = store.ritmo;
    footRitmo.replaceChildren();
    if (rt && rt.fase !== 'aguardando') {
      const { principal, nota } = textoRitmo(rt);
      footRitmo.append(el('span', { class: 'l', text: 'Ritmo' }), el('span', { class: 'num', text: principal }));
      if (nota) footRitmo.append(el('span', { class: 'nota', text: nota }));
    }
    footCaminho.replaceChildren();
    const rc = resumoCaminho(store, store.caminho);
    if (rc) {
      footCaminho.append(el('span', { class: 'l', text: 'Faltam' }), el('span', { class: 'num', text: rc.faltam.replace(/^Faltam /, '') }));
      if (rc.precisa) footCaminho.append(el('span', { class: 'sep' }), el('span', { text: rc.precisa }));
    }
  };

  const renderTudo = () => {
    if (!aberto) return;
    renderTopo();
    renderPlacar();
    renderUf();
    renderFoot();
    mapa?.render();
  };

  // ------------------------------------------------------------- carrossel
  const irPara = (i: number, manual = false) => {
    idx = i;
    renderUf();
    if (manual) reiniciarCarrossel();
  };
  const avancar = () => irPara(idx + 1);
  const reiniciarCarrossel = () => {
    if (timer) clearInterval(timer);
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') avancar();
    }, INTERVALO_CARROSSEL);
  };

  // ------------------------------------------------------------- abrir / fechar
  const aoTecla = (e: KeyboardEvent) => {
    if (!aberto) return;
    if (e.key === 'Escape') fechar();
    else if (e.key === 'ArrowRight') irPara(idx + 1, true);
    else if (e.key === 'ArrowLeft') irPara(idx - 1, true);
  };
  const aoFullscreen = () => {
    if (aberto && pediuFullscreen && !document.fullscreenElement) fechar();
  };

  const abrir: TelaoApi['abrir'] = (opts = {}) => {
    if (aberto) return;
    if (!overlay) construir();
    aberto = true;
    const html = document.documentElement;
    html.setAttribute('data-theme', 'dark'); // escuro forçado; ao sair volta a escolha do usuário (localStorage.tema)
    html.classList.add('telao-aberto');
    store.atualizarTema();
    mapa?.lerCores();
    overlay!.hidden = false;
    if (location.hash !== '#telao') history.replaceState(null, '', '#telao');
    document.addEventListener('keydown', aoTecla);
    document.addEventListener('fullscreenchange', aoFullscreen);
    pediuFullscreen = false;
    if (opts.fullscreen && html.requestFullscreen) {
      html
        .requestFullscreen({ navigationUI: 'hide' })
        .then(() => (pediuFullscreen = true))
        .catch(() => {});
    }
    if (!geoCarregada) {
      geoCarregada = true;
      topoUf()
        .then((t) => {
          mapa?.setGeoUf(t);
          renderUf();
        })
        .catch((e) => {
          geoCarregada = false;
          console.warn('telão: malha indisponível', e);
        });
    }
    renderTudo();
    reiniciarCarrossel();
    relogio = window.setInterval(renderTopo, 1000);
    sair.focus({ preventScroll: true });
  };

  const fechar = () => {
    if (!aberto) return;
    aberto = false;
    if (timer) clearInterval(timer);
    if (relogio) clearInterval(relogio);
    timer = relogio = null;
    document.removeEventListener('keydown', aoTecla);
    document.removeEventListener('fullscreenchange', aoFullscreen);
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    const html = document.documentElement;
    html.classList.remove('telao-aberto');
    aplicarTema(lerTema()); // a escolha do usuário (claro/escuro/automático), não "auto" a seco
    store.atualizarTema();
    if (overlay) overlay.hidden = true;
    mapa?.realcarUf(null);
    if (location.hash === '#telao') history.replaceState(null, '', location.pathname + location.search);
  };

  store.on(['br', 'meta', 'tema'], () => {
    if (!aberto) return;
    renderTopo();
    renderPlacar();
    mapa?.render();
  });
  store.on(['uf', 'tema'], () => {
    if (!aberto) return;
    renderUf();
    mapa?.render();
  });
  store.on(['ritmo', 'caminho', 'br'], () => aberto && renderFoot());
  store.on('tema', () => {
    if (!aberto) return;
    mapa?.lerCores();
    mapa?.render();
  });

  return {
    abrir,
    fechar,
    get aberto() {
      return aberto;
    },
  };
}
