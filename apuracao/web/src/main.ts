import './styles.css';
import { descobrirAtivo, getJson, HttpError, Poller, urls, type Chave, type Payloads } from './api';
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
import { montarAlertas } from './alertas';
import { montarRecursos } from './recursos';
import { montarAguardando } from './ui/aguardando';
import type { Ativo } from './types';

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
      el('span', { class: 'footer-fonte', text: 'Reexibimos o arquivo oficial do TSE. Abra o link ao lado de cada número e compare.' }),
      el('span', {}, el('a', { href: '/acervo', text: 'Acervo de dados históricos' })),
    ),
  );
}

async function iniciar(): Promise<void> {
  const store = new Store();
  montarRodape();

  // 1. descobre o snapshot ativo e carrega meta + referências em paralelo
  const { ativo, prefixo } = await descobrirAtivo();
  const u = urls(prefixo);
  const [meta, refUfs] = await Promise.all([
    // meta.json só existe depois do primeiro boletim do TSE: 404 = apuração ainda não começou
    getJson<Meta>(u.meta).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }),
    getJson<RefUfs>(`${ESTATICO}ref/ufs.json`).catch(() => ({}) as RefUfs),
  ]);
  store.setRef(refUfs, null);
  if (!meta) {
    modoAguardando(store, ativo, u.status);
    return;
  }
  store.setMeta(meta);
  if ((meta as Meta & { simulacao?: boolean }).simulacao) {
    // ensaio geral (apuracao simular): deixa claro que nada aqui é resultado real
    const aviso = document.createElement('div');
    aviso.className = 'aviso-simulacao';
    aviso.setAttribute('role', 'status');
    aviso.textContent = 'SIMULAÇÃO · ensaio com dados do 1º turno redistribuídos · não é resultado';
    aviso.style.cssText =
      'position:sticky;top:0;z-index:60;background:#b91c1c;color:#fff;text-align:center;font-weight:700;letter-spacing:.04em;padding:6px 16px;font-size:13px';
    document.body.prepend(aviso);
  }

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
        case 'caminho':
          store.setCaminho(dados as Payloads['caminho']);
          break;
        case 'ritmo':
          store.setRitmo(dados as Payloads['ritmo']);
          break;
      }
    },
    (e, chave) => {
      // caminho.json / ritmo.json são opcionais (snapshots antigos não os têm): 404 não é falha.
      if (e instanceof HttpError && e.status === 404 && (chave === 'caminho' || chave === 'ritmo')) return;
      console.warn(`falha ao atualizar ${chave}`, e);
      if (++errosSeguidos >= 3) mostrarErro('Sem conexão com os dados da apuração. Tentando novamente…');
    },
  );

  // 3. interface
  montarCabecalho($('topbar'), store, poller);
  montarAlertas($('alertas'));
  const chat = montarChat($('chat'), store);
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
  montarRecursos(store, secao, { topoUf: () => getJson<Topology>(`${ESTATICO}geo/br-uf.topo.json`), topoMun: () => getJson<Topology>(`${ESTATICO}geo/br-mun.topo.json`) }, chat);
  $('app').setAttribute('aria-busy', 'false');

  // 4. polling
  poller.registrar('br', u.br);
  poller.registrar('uf', u.uf);
  poller.registrar('status', u.status);
  poller.registrar('timeline', u.timeline);
  poller.registrar('caminho', u.caminho);
  poller.registrar('ritmo', u.ritmo);

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

/**
 * Antes do primeiro boletim: cabeçalho com indicador ao vivo, alertas e chat funcionando, e um
 * cartão explicando o que vem. A cada 30 s confere se meta.json apareceu; quando aparecer,
 * recarrega a página e entra no modo normal.
 */
function modoAguardando(store: Store, ativo: Ativo, urlStatus: string): void {
  const INTERVALO = 30_000;
  let errosSeguidos = 0;
  const poller = new Poller(
    (chave, dados) => {
      if (chave !== 'status') return;
      errosSeguidos = 0;
      mostrarErro(null);
      store.setStatus(dados as Payloads['status']);
      card.atualizar(store.status, true);
    },
    (e) => {
      console.warn('falha ao atualizar status', e);
      card.atualizar(store.status, false);
      if (++errosSeguidos >= 3) mostrarErro('Sem conexão com os dados da apuração. Tentando novamente…');
    },
  );
  montarCabecalho($('topbar'), store, poller);
  montarAlertas($('alertas'));
  montarChat($('chat'), store);
  const card = montarAguardando($('hero'), ativo);
  $('app').setAttribute('aria-busy', 'false');
  poller.registrar('status', urlStatus, INTERVALO);

  let conferindo = false;
  const conferir = async () => {
    if (conferindo || document.visibilityState === 'hidden') return;
    conferindo = true;
    try {
      const { prefixo } = await descobrirAtivo();
      await getJson<Meta>(urls(prefixo).meta);
      location.reload(); // meta.json existe: a apuração começou
    } catch {
      /* ainda não começou (404) ou sem rede: tenta de novo no próximo ciclo */
    } finally {
      conferindo = false;
    }
  };
  setInterval(() => void conferir(), INTERVALO);
  document.addEventListener('visibilitychange', () => void conferir());
}

iniciar().catch((e) => {
  console.error(e);
  mostrarErro('Não foi possível carregar a apuração. Recarregue a página em alguns instantes.');
  $('app').setAttribute('aria-busy', 'false');
});
