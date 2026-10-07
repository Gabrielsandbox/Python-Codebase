import './styles.css';
import { descobrirAtivo, getJson, Poller, urls, type Chave, type Payloads } from './api';
import { el } from './format';
import { Store } from './store';
import type { Meta, RefMunicipios, RefUfs } from './types';
import type { Topology } from 'topojson-specification';
import { montarCabecalho } from './ui/cabecalho';
import { montarPlacar } from './ui/placar';
import { montarSecaoMapa } from './ui/secaoMapa';
import { montarTotais } from './ui/totais';
import { montarLinha } from './ui/linha';
import { montarTabela } from './ui/tabela';
import { montarChat } from './chat';

// Base dos arquivos estáticos (geo/ref): '/' normalmente, './' em builds relativos (--base ./).
const ESTATICO: string = import.meta.env.BASE_URL;

const $ = (id: string) => document.getElementById(id)!;

function mostrarErro(msg: string | null): void {
  const e = $('erro');
  e.hidden = !msg;
  e.textContent = msg ?? '';
}

function montarRodape(): void {
  $('rodape').append(
    el(
      'div',
      { class: 'footer-inner' },
      el('span', {}, 'Fonte: TSE (', el('a', { href: 'https://resultados.tse.jus.br', rel: 'noopener', target: '_blank', text: 'resultados.tse.jus.br' }), '). Dados oficiais, sem projeções.'),
      el('span', {}, el('a', { href: '/acervo', text: 'Acervo de dados históricos' })),
    ),
  );
}

async function iniciar(): Promise<void> {
  const store = new Store();
  montarRodape();

  // 1. descobre o snapshot ativo e carrega meta + referências em paralelo
  const { prefixo } = await descobrirAtivo();
  const u = urls(prefixo);
  const [meta, refUfs] = await Promise.all([getJson<Meta>(u.meta), getJson<RefUfs>(`${ESTATICO}ref/ufs.json`).catch(() => ({}) as RefUfs)]);
  store.setRef(refUfs, null);
  store.setMeta(meta);

  // 2. polling: criado antes da interface para o cabeçalho acompanhar os ciclos
  let errosSeguidos = 0;
  const poller = new Poller(
    <K extends Chave>(chave: K, dados: Payloads[K]) => {
      errosSeguidos = 0;
      mostrarErro(null);
      switch (chave) {
        case 'br':
          store.setBr(dados as Payloads['br']);
          break;
        case 'uf':
          store.setUf(dados as Payloads['uf']);
          break;
        case 'mun':
          store.setMun(dados as Payloads['mun']);
          break;
        case 'status':
          store.setStatus(dados as Payloads['status']);
          break;
        case 'timeline':
          store.setTimeline(dados as Payloads['timeline']);
          break;
      }
    },
    (e, chave) => {
      console.warn(`falha ao atualizar ${chave}`, e);
      if (++errosSeguidos >= 3) mostrarErro('Sem conexão com os dados da apuração. Tentando novamente…');
    },
  );

  // 3. interface
  montarCabecalho($('topbar'), store, poller);
  montarChat($('chat'));
  montarPlacar($('hero'), store);
  const secao = montarSecaoMapa($('mapa'), store);
  montarTotais($('totais'), store);
  montarLinha($('linha'), store);
  montarTabela(
    $('tabela'),
    store,
    (sigla) => {
      store.selecionarUf(sigla);
      $('mapa').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    (sigla) => secao.mapa.realcarUf(sigla),
  );
  $('app').setAttribute('aria-busy', 'false');

  // 4. polling
  poller.registrar('br', u.br);
  poller.registrar('uf', u.uf);
  poller.registrar('status', u.status);
  poller.registrar('timeline', u.timeline);

  // 5. geometria: estados primeiro (pequeno), municípios + referência em segundo plano
  secao.mostrarCarregando('Carregando mapa…');
  const topoUf = await getJson<Topology>(`${ESTATICO}geo/br-uf.topo.json`);
  secao.mapa.setGeoUf(topoUf);
  secao.mostrarCarregando(null);

  poller.registrar('mun', u.mun);
  void (async () => {
    try {
      const [topoMun, refMun] = await Promise.all([getJson<Topology>(`${ESTATICO}geo/br-mun.topo.json`), getJson<RefMunicipios>(`${ESTATICO}ref/municipios.json`).catch(() => null)]);
      if (refMun) store.setRef(store.refUfs, refMun);
      await secao.mapa.setGeoMun(topoMun);
      (window as unknown as { __munPronto?: boolean }).__munPronto = true;
    } catch (e) {
      console.warn('malha municipal indisponível', e);
    }
  })();
}

iniciar().catch((e) => {
  console.error(e);
  mostrarErro('Não foi possível carregar a apuração. Recarregue a página em alguns instantes.');
  $('app').setAttribute('aria-busy', 'false');
});
