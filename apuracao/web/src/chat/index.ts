// Painel do chat ao vivo: coluna à direita no desktop (≥1100 px), bottom sheet no
// celular. Fluxo: paywall → checkout → retorno com ?chat_ref= → token → sala (WS).

import './chat-ext.css';
import { el, fmtInt } from '../format';
import type { Store } from '../store';
import { acesso, ChatHttpError, estado as lerEstado, guardarSessao, lerSessao, type Estado, type Sessao } from './client';
import { montarPaywall, type VariantePaywall } from './paywall';
import { montarPrevia } from './previa';
import { montarSala } from './sala';
import { lerSalaGuardada, montarSeletorSalas, SALA_GERAL, ufDoHash } from './salas';

const DESKTOP = '(min-width: 1100px)';
const CHAVE_PAINEL = 'chat_painel'; // preferência de aberto/fechado no desktop
const RETORNO_PARAM = 'chat_ref';

type Tela = 'paywall' | 'aguardando' | 'sala';

/** Superfície mínima para outros módulos (telão faz parte do pacote: o token do chat é a prova de compra). */
export interface ChatApi {
  abrir(v: boolean): void;
  readonly aberto: boolean;
  /** Sessão guardada neste navegador (token + apelido) ou null. */
  sessao(): Sessao | null;
  /** Mostra o paywall na variante dada e abre o painel. */
  pedirPagamento(variante: VariantePaywall, aviso?: string | null): void;
  /** Troca a manchete do paywall sem abrir o painel. */
  setVariante(variante: VariantePaywall): void;
  /** Servidor recusou o token (401): apaga a sessão local e volta ao paywall. */
  sessaoInvalida(variante?: VariantePaywall): void;
  /** Chamado quando /chat/acesso devolve um token novo (depois do pagamento). */
  onSessao(cb: (s: Sessao) => void): void;
}

export function montarChat(raiz: HTMLElement, store: Store): ChatApi {
  const mq = matchMedia(DESKTOP);
  const html = document.documentElement;

  // ---------------------------------------------------------------- casca
  const onlineHead = el('span', { class: 'chat-online num', text: '' });
  const conn = el('span', { class: 'chat-conn', hidden: true }, el('i', { 'aria-hidden': 'true' }), el('span', { class: 'txt' }));
  const btnFechar = el('button', { class: 'chat-x', type: 'button', 'aria-label': 'Fechar chat', title: 'Fechar' }, iconeX());
  const alca = el('i', { class: 'chat-handle', 'aria-hidden': 'true' });
  // seletor de sala (Geral + UFs) — só aparece com a sessão ativa
  const seletor = montarSeletorSalas({
    salaInicial: lerSalaGuardada(),
    nomeUf: (sigla) => store.refUfs[sigla]?.nome,
    aoTrocar: (nova) => trocarSala(nova),
  });
  seletor.raiz.hidden = true;
  const head = el(
    'header',
    { class: 'chat-head' },
    alca,
    el('div', { class: 'chat-title' }, el('h2', { text: 'Chat ao vivo' }), el('div', { class: 'chat-meta' }, onlineHead, conn)),
    seletor.raiz,
    btnFechar,
  );
  const corpo = el('div', { class: 'chat-body' });
  const painel = el('div', { class: 'chat-panel' }, head, corpo);

  // trilho fechado (desktop): botão vertical para reabrir
  const railOnline = el('span', { class: 'num', text: '' });
  const rail = el(
    'button',
    { class: 'chat-rail', type: 'button', 'aria-label': 'Abrir chat ao vivo', title: 'Abrir chat' },
    iconeChat(),
    el('span', { class: 'rail-txt' }, el('b', { text: 'Chat ao vivo' }), railOnline),
  );

  raiz.append(rail, painel);

  // botão flutuante (celular) + fundo escurecido do bottom sheet
  const fabOnline = el('span', { class: 'num', text: '' });
  const fab = el(
    'button',
    { class: 'chat-fab', type: 'button', 'aria-controls': raiz.id, 'aria-expanded': 'false' },
    el('i', { class: 'live-dot', 'aria-hidden': 'true' }),
    el('span', { text: 'Chat ao vivo' }),
    fabOnline,
  );
  const backdrop = el('div', { class: 'chat-backdrop', hidden: true });
  document.body.append(fab, backdrop);

  // ---------------------------------------------------------------- aberto/fechado
  const lerPref = (): boolean => {
    try {
      return localStorage.getItem(CHAVE_PAINEL) !== 'fechado';
    } catch {
      return true;
    }
  };
  let aberto = mq.matches ? lerPref() : false;

  const aplicarAbertura = () => {
    html.dataset.chat = aberto ? 'aberto' : 'fechado';
    html.dataset.chatLayout = mq.matches ? 'coluna' : 'sheet';
    fab.setAttribute('aria-expanded', String(aberto));
    backdrop.hidden = !(aberto && !mq.matches);
    rail.hidden = aberto || !mq.matches;
    painel.setAttribute('aria-hidden', String(!aberto));
    btnFechar.title = mq.matches ? 'Recolher' : 'Fechar';
    btnFechar.setAttribute('aria-label', mq.matches ? 'Recolher chat' : 'Fechar chat');
    if (!mq.matches) {
      if (aberto) ligarViewport();
      else desligarViewport();
    } else desligarViewport();
  };

  const abrir = (v: boolean) => {
    aberto = v;
    if (mq.matches) {
      try {
        localStorage.setItem(CHAVE_PAINEL, v ? 'aberto' : 'fechado');
      } catch {
        /* sem armazenamento */
      }
    }
    aplicarAbertura();
    sincronizarPrevia();
    if (v) (corpo.querySelector<HTMLElement>('[data-foco]') ?? btnFechar).focus({ preventScroll: true });
    else if (!mq.matches) fab.focus({ preventScroll: true });
  };

  btnFechar.addEventListener('click', () => abrir(false));
  rail.addEventListener('click', () => abrir(true));
  fab.addEventListener('click', () => abrir(!aberto));
  backdrop.addEventListener('click', () => abrir(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aberto && !mq.matches) abrir(false);
  });
  mq.addEventListener('change', () => {
    aberto = mq.matches ? lerPref() : false;
    aplicarAbertura();
    sincronizarPrevia();
  });

  // ---------------------------------------------------------------- teclado no celular (visualViewport)
  const vv = window.visualViewport;
  const ajustarViewport = () => {
    if (!vv) return;
    const tecladoAberto = vv.height < window.innerHeight * 0.75;
    const altura = tecladoAberto ? Math.max(240, vv.height - 8) : Math.round(vv.height * 0.7);
    const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    raiz.style.setProperty('--sheet-h', `${altura}px`);
    raiz.style.setProperty('--sheet-bottom', `${bottom}px`);
  };
  let viewportLigado = false;
  function ligarViewport() {
    if (viewportLigado || !vv) return;
    viewportLigado = true;
    vv.addEventListener('resize', ajustarViewport);
    vv.addEventListener('scroll', ajustarViewport);
    ajustarViewport();
  }
  function desligarViewport() {
    if (!viewportLigado || !vv) return;
    viewportLigado = false;
    vv.removeEventListener('resize', ajustarViewport);
    vv.removeEventListener('scroll', ajustarViewport);
    raiz.style.removeProperty('--sheet-h');
    raiz.style.removeProperty('--sheet-bottom');
  }

  // ---------------------------------------------------------------- arrastar para fechar (celular)
  let y0: number | null = null;
  head.addEventListener(
    'touchstart',
    (e) => {
      if (mq.matches) return;
      y0 = e.touches[0].clientY;
      painel.style.transition = 'none';
    },
    { passive: true },
  );
  head.addEventListener(
    'touchmove',
    (e) => {
      if (y0 === null) return;
      const dy = Math.max(0, e.touches[0].clientY - y0);
      painel.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );
  const soltar = (e: TouchEvent) => {
    if (y0 === null) return;
    const dy = (e.changedTouches[0]?.clientY ?? y0) - y0;
    y0 = null;
    painel.style.transition = '';
    painel.style.transform = '';
    if (dy > 90) abrir(false);
  };
  head.addEventListener('touchend', soltar);
  head.addEventListener('touchcancel', soltar);

  // ---------------------------------------------------------------- telas
  let tela: Tela = 'paywall';

  const paywall = montarPaywall({
    aoCheckout: () => {
      /* o navegador será redirecionado */
    },
  });
  // feed somente leitura da sala, desfocado atrás do cartão do paywall (GET /chat/previa a cada 5 s)
  const previa = montarPrevia();
  previa.aoAtualizar = (n) => {
    if (tela === 'paywall') setOnline(n);
  };
  const painelPaywall = el('div', { class: 'chat-pay-wrap' }, previa.raiz, el('div', { class: 'chat-pay-overlay' }, paywall.raiz));
  /** O feed só atualiza com o paywall visível (painel aberto) — para quando fecha ou troca de tela. */
  function sincronizarPrevia() {
    if (tela === 'paywall' && aberto) previa.ligar();
    else previa.desligar();
  }
  const ouvintesSessao: ((s: Sessao) => void)[] = [];

  const sala = montarSala({
    store,
    aoPresenca: (n) => setOnline(n),
    aoConexao: (estado) => {
      conn.hidden = estado === 'desligado';
      conn.dataset.estado = estado;
      conn.querySelector('.txt')!.textContent = estado === 'aovivo' ? 'ao vivo' : estado === 'conectando' ? 'conectando…' : estado === 'reconectando' ? 'reconectando…' : '';
    },
    aoExpirar: () => {
      guardarSessao(null);
      paywall.setVariante('chat');
      mostrar('paywall');
      paywall.aviso('Seu acesso expirou ou não foi reconhecido. Entre de novo para continuar.');
    },
    aoSair: () => {
      guardarSessao(null);
      paywall.setVariante('chat');
      mostrar('paywall');
    },
    aoTrocarSala: (nova) => trocarSala(nova),
  });

  // ---------------------------------------------------------------- salas
  let sessaoAtual: Sessao | null = null;
  function trocarSala(nova: string): void {
    seletor.setSala(nova);
    if (!sessaoAtual || tela !== 'sala') return;
    online = null;
    renderOnline();
    sala.ligar(sessaoAtual, nova);
    sala.sugerirSala(ufDoHash());
  }
  window.addEventListener('hashchange', () => sala.sugerirSala(ufDoHash()));

  // ---------------------------------------------------------------- contadores de online
  let online: number | null = null;
  let ultimoEstado: Estado | null = null;
  const renderOnline = () => {
    const naSala = tela === 'sala' && sala.sala !== SALA_GERAL;
    const txt = online === null ? '' : `${fmtInt(online)} ${naSala ? 'na sala' : 'online'}`;
    onlineHead.textContent = txt;
    // trilho e botão flutuante mostram o total do chat (todas as salas)
    const total = tela === 'sala' && ultimoEstado ? ultimoEstado.online : online;
    railOnline.textContent = total === null ? '' : `${fmtInt(total)} online`;
    fabOnline.textContent = total === null ? '' : `· ${fmtInt(total)} online`;
  };
  const setOnline = (n: number) => {
    online = n;
    renderOnline();
    paywall.setEstado(ultimoEstado, n);
  };

  const atualizarEstado = async () => {
    try {
      ultimoEstado = await lerEstado();
      seletor.setSalas(ultimoEstado.salas);
      // com o WS aberto, a presença do servidor (por sala) é mais fresca que /estado
      if (tela !== 'sala' || !sala.conectado) setOnline(ultimoEstado.online);
      else {
        paywall.setEstado(ultimoEstado, online ?? ultimoEstado.online);
        renderOnline();
      }
    } catch {
      /* /estado é só decorativo */
    }
  };
  void atualizarEstado();
  setInterval(() => {
    if (document.visibilityState === 'visible') void atualizarEstado();
  }, 30_000);

  const mostrar = (t: Tela, sessao?: Sessao) => {
    tela = t;
    corpo.replaceChildren();
    if (t !== 'sala') {
      sala.desligar();
      seletor.desligar();
      sessaoAtual = null;
    }
    seletor.raiz.hidden = t !== 'sala';
    if (t === 'paywall') corpo.append(painelPaywall);
    else if (t === 'aguardando') corpo.append(telaAguardando());
    else if (sessao) {
      sessaoAtual = sessao;
      corpo.append(sala.raiz);
      // deep link #uf=XX sem sala guardada: sugere a sala da UF (chip), sem trocar sozinho
      sala.ligar(sessao, seletor.sala);
      sala.sugerirSala(ufDoHash());
      seletor.ligar();
    }
    raiz.dataset.tela = t;
    if (t !== 'sala') conn.hidden = true;
    renderOnline();
    sincronizarPrevia();
  };

  // ---------------------------------------------------------------- retorno do pagamento
  let aguardandoTxt: HTMLElement | null = null;
  const telaAguardando = () => {
    aguardandoTxt = el('p', { class: 'aguardando-txt', text: 'confirmando pagamento…' });
    return el(
      'div',
      { class: 'chat-aguardando', role: 'status' },
      el('div', { class: 'spinner', 'aria-hidden': 'true' }),
      el('h3', { text: 'Quase lá' }),
      aguardandoTxt,
      el('p', { class: 'hint', text: 'Se você pagou com PIX, a confirmação costuma levar alguns segundos. Pode deixar esta aba aberta.' }),
    );
  };

  const limparUrl = () => {
    const u = new URL(location.href);
    if (!u.searchParams.has(RETORNO_PARAM)) return;
    u.searchParams.delete(RETORNO_PARAM);
    history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
  };

  const concluirPagamento = async (ref: string) => {
    mostrar('aguardando');
    if (!mq.matches) abrir(true);
    let tentativas = 0;
    for (;;) {
      try {
        const a = await acesso(ref);
        const sessao = { token: a.token, apelido: a.apelido };
        guardarSessao(sessao);
        limparUrl();
        mostrar('sala', sessao);
        for (const cb of ouvintesSessao) cb(sessao);
        return;
      } catch (e) {
        if (e instanceof ChatHttpError && e.status === 402) {
          tentativas++;
          if (aguardandoTxt) aguardandoTxt.textContent = tentativas > 1 ? `aguardando confirmação do PIX… (${tentativas})` : 'aguardando confirmação do PIX…';
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        limparUrl();
        mostrar('paywall');
        paywall.aviso(
          e instanceof ChatHttpError && e.status === 404
            ? 'Não encontramos esse pagamento. Se o valor foi cobrado, fale com o suporte.'
            : e instanceof ChatHttpError && e.status === 410
              ? 'A sessão de pagamento expirou antes de ser concluída. Nada foi cobrado; comece de novo.'
              : 'Não foi possível confirmar o pagamento agora. Tente novamente em instantes.',
        );
        return;
      }
    }
  };

  // ---------------------------------------------------------------- início
  aplicarAbertura();
  const ref = new URL(location.href).searchParams.get(RETORNO_PARAM);
  const sessao = lerSessao();
  if (ref) void concluirPagamento(ref);
  else if (sessao) mostrar('sala', sessao);
  else mostrar('paywall');

  return {
    abrir,
    get aberto() {
      return aberto;
    },
    sessao: () => (tela === 'sala' ? sessaoAtual : lerSessao()),
    pedirPagamento(variante, msg = null) {
      // já pagou (sala) ou está confirmando o pagamento: só abre o painel
      if (tela !== 'sala' && tela !== 'aguardando') {
        paywall.setVariante(variante);
        if (tela !== 'paywall') mostrar('paywall');
        paywall.aviso(msg);
      }
      abrir(true);
    },
    setVariante: (v) => paywall.setVariante(v),
    sessaoInvalida(variante = 'chat') {
      guardarSessao(null);
      paywall.setVariante(variante);
      mostrar('paywall');
      paywall.aviso('Seu acesso expirou ou não foi reconhecido. Entre de novo para continuar.');
    },
    onSessao: (cb) => {
      ouvintesSessao.push(cb);
    },
  };
}

function iconeX(): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 3l10 10M13 3L3 13');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  s.append(p);
  return s;
}

function iconeChat(): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v8a1.5 1.5 0 0 1-1.5 1.5H8l-4 3v-3h-.5A1.5 1.5 0 0 1 3 12.5v-8z');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}
