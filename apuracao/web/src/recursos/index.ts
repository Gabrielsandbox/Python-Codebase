// Recursos da noite (docs/RECURSOS.md): caminho para a vitória, ritmo, meu município,
// modo telão, "confira na fonte" e deep links (#m=<ibge>, #uf=<SIGLA>, #telao).
// Um único ponto de montagem para o main.ts.

import '../recursos.css';
import type { Topology } from 'topojson-specification';
import { el } from '../format';
import type { Store } from '../store';
import type { SecaoMapa } from '../ui/secaoMapa';
import { montarCaminho } from './caminho';
import { atualizarFonte, linkFonte, urlFonteBr } from './fonte';
import { montarMunicipio } from './municipio';
import { montarRitmoIndicador } from './ritmo';
import { montarTelao } from './telao';

export interface Geo {
  topoUf: () => Promise<Topology>;
  topoMun: () => Promise<Topology>;
}

export function montarRecursos(store: Store, secao: SecaoMapa, geo: Geo): void {
  const $ = (id: string) => document.getElementById(id);

  // ---- barra superior: ritmo + botão Telão (ao lado do indicador "ao vivo")
  const status = document.querySelector<HTMLElement>('#topbar .status');
  const telao = montarTelao(store, geo.topoUf);
  if (status) {
    montarRitmoIndicador(status, store);
    const btn = el('button', { class: 'btn btn-telao', type: 'button', title: 'Modo telão: tela cheia com placar gigante e mapa (Esc sai)' }, el('i', { class: 'ico', 'aria-hidden': 'true' }), el('span', { text: 'Telão' }));
    btn.addEventListener('click', () => telao.abrir({ fullscreen: true }));
    status.append(btn);
  }

  // ---- caminho para a vitória (logo abaixo do placar)
  const secCaminho = $('caminho');
  if (secCaminho) montarCaminho(secCaminho, store);

  // ---- meu município (coluna lateral do mapa)
  const side = document.querySelector<HTMLElement>('#mapa .side') ?? $('mapa');
  const municipio = side ? montarMunicipio(side, store, secao, geo.topoMun) : null;

  // ---- "fonte: TSE" no placar nacional
  const kicker = document.querySelector<HTMLElement>('#hero .hero-kicker');
  if (kicker) {
    const a = linkFonte(urlFonteBr(store));
    kicker.insertBefore(a, kicker.children[1] ?? null);
    store.on(['br', 'meta'], () => atualizarFonte(a, urlFonteBr(store)));
  }

  // ---- deep links
  let munPendente: string | null = null;
  const abrirMun = (ibge: string) => {
    if (!municipio) return;
    if (store.mun && store.refMun) {
      munPendente = null;
      municipio.abrir(ibge, { rolar: true, mapa: true });
    } else munPendente = ibge;
  };
  store.on(['mun', 'ref'], () => {
    if (munPendente && store.mun && store.refMun) abrirMun(munPendente);
  });

  const aplicarHash = () => {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!h) return;
    if (h === 'telao') {
      telao.abrir();
      return;
    }
    const m = /^m=(\d{7})$/.exec(h);
    if (m) {
      abrirMun(m[1]);
      return;
    }
    const u = /^uf=([A-Za-z]{2})$/.exec(h);
    if (u) {
      const sigla = u[1].toUpperCase();
      store.selecionarUf(sigla);
      $('mapa')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  window.addEventListener('hashchange', aplicarHash);
  aplicarHash();
}
