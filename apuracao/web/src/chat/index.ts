// Painel do chat ao vivo: coluna à direita no desktop (≥1100 px); no celular, painel ancorado
// embaixo que divide a tela com a apuração (altura ajustável arrastando o cabeçalho). Fluxo: paywall → checkout → retorno com ?chat_ref= → token → sala (WS).

import './chat-ext.css';
import { el, fmtInt } from '../format';
import type { Store } from '../store';
import { acesso, ChatHttpError, contaGoogle, entrar, estado as lerEstado, guardarSessao, lerSessao, type Acesso, type Estado, type Sessao, ONLINE_MINIMO } from './client';
import { montarPaywall, type VariantePaywall } from './paywall';
import { montarPrevia } from './previa';
import { montarSala } from './sala';
import { lerSalaGuardada, montarSeletorSalas, SALA_GERAL, ufDoHash } from './salas';

const DESKTOP = '(min-width: 1100px)';
const CHAVE_PAINEL = 'chat_painel'; // preferência de aberto/fechado no desktop
const CHAVE_ALTURA = 'chat_altura'; // fração da tela ocupada pelo painel ancorado (celular)
const ALTURA_PADRAO = 0.55;
const ALTURA_PAYWALL = 0.66; // no paywall o botão de pagar precisa aparecer sem rolar
const ALTURA_MIN = 0.34;
const ALTURA_MAX = 0.88;
const RETORNO_PARAM = 'chat_ref';
const LOGIN_PARAM = 'login'; // link de acesso enviado por e-mail (conta)

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
    backdrop.hidden = true; // painel ancorado: a página continua visível e rolável por cima
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
  const lerFracao = (): number => {
    try {
      const v = parseFloat(localStorage.getItem(CHAVE_ALTURA) ?? '');
      if (Number.isFinite(v)) return Math.min(ALTURA_MAX, Math.max(ALTURA_MIN, v));
    } catch {
      /* sem armazenamento */
    }
    return ALTURA_PADRAO;
  };
  let fracao = lerFracao();
  const aplicarAltura = (altura: number, bottom: number) => {
    raiz.style.setProperty('--sheet-h', `${altura}px`);
    raiz.style.setProperty('--sheet-bottom', `${bottom}px`);
    // a página ganha esse espaço embaixo para continuar rolável até o fim
    html.style.setProperty('--dock-h', `${altura + bottom}px`);
  };
  const ajustarViewport = () => {
    if (!vv) return;
    const tecladoAberto = vv.height < window.innerHeight * 0.75;
    const alvo = tela === 'paywall' ? Math.max(fracao, ALTURA_PAYWALL) : fracao;
    const altura = tecladoAberto ? Math.max(240, vv.height - 8) : Math.round(vv.height * alvo);
    const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    aplicarAltura(altura, bottom);
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
    html.style.removeProperty('--dock-h');
  }

  // ---------------------------------------------------------------- arrastar o cabeçalho: ajusta a altura (celular)
  // Para cima aumenta, para baixo diminui; abaixo do mínimo, fecha. A altura escolhida fica guardada.
  let y0: number | null = null;
  let h0 = 0;
  head.addEventListener(
    'touchstart',
    (e) => {
      if (mq.matches) return;
      y0 = e.touches[0].clientY;
      h0 = raiz.getBoundingClientRect().height;
      raiz.style.transition = 'none';
    },
    { passive: true },
  );
  head.addEventListener(
    'touchmove',
    (e) => {
      if (y0 === null) return;
      const h = Math.min(window.innerHeight * ALTURA_MAX, Math.max(120, h0 - (e.touches[0].clientY - y0)));
      raiz.style.setProperty('--sheet-h', `${Math.round(h)}px`);
      html.style.setProperty('--dock-h', `${Math.round(h)}px`);
    },
    { passive: true },
  );
  const soltar = (e: TouchEvent) => {
    if (y0 === null) return;
    const h = h0 - ((e.changedTouches[0]?.clientY ?? y0) - y0);
    y0 = null;
    raiz.style.transition = '';
    const base = vv?.height ?? window.innerHeight;
    if (h < base * 0.26) {
      abrir(false);
      return;
    }
    fracao = Math.min(ALTURA_MAX, Math.max(ALTURA_MIN, h / base));
    try {
      localStorage.setItem(CHAVE_ALTURA, fracao.toFixed(3));
    } catch {
      /* sem armazenamento */
    }
    ajustarViewport();
  };
  head.addEventListener('touchend', soltar);
  head.addEventListener('touchcancel', soltar);

  // ---------------------------------------------------------------- telas
  let tela: Tela = 'paywall';

  const sessaoDe = (a: Acesso): Sessao => ({ token: a.token, apelido: a.apelido, autor: a.autor, email: a.email, pago: a.pago });
  /** Conta logada mas sem os R$ 5: paywall só com apelido + pagar. */
  const entrarSemPagar = (sessao: Sessao, msg: string | null = null) => {
    guardarSessao({ ...sessao, pago: false });
    paywall.setConta(sessao);
    mostrar('paywall');
    paywall.aviso(msg);
  };
  const paywall = montarPaywall({
    aoCheckout: () => {
      /* o navegador será redirecionado */
    },
    aoGoogle: async (credential) => {
      try {
        const a = await contaGoogle(credential);
        const sessao = sessaoDe(a);
        guardarSessao(sessao);
        if (a.pago) {
          mostrar('sala', sessao);
          for (const cb of ouvintesSessao) cb(sessao);
        } else entrarSemPagar(sessao);
      } catch (e) {
        paywall.aviso(
          e instanceof ChatHttpError && e.status === 501
            ? 'Entrar com Google ainda não está disponível. Use o acesso por e-mail.'
            : e instanceof ChatHttpError && e.status === 401
              ? 'O Google não confirmou sua conta. Tente de novo.'
              : 'Não foi possível entrar agora. Tente de novo em instantes.',
        );
      }
    },
    aoTrocarConta: () => {
      guardarSessao(null);
      window.google?.accounts.id.disableAutoSelect();
      paywall.setConta(null);
      mostrar('paywall');
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
      window.google?.accounts.id.disableAutoSelect();
      paywall.setVariante('chat');
      paywall.setConta(null);
      mostrar('paywall');
    },
    aoSemPagamento: () => {
      const s = sessaoAtual ?? lerSessao();
      paywall.setVariante('chat');
      if (s) entrarSemPagar(s, 'Sua conta ainda não tem o chat liberado. Pague os R$ 5 para entrar.');
      else mostrar('paywall');
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
    // abaixo de ONLINE_MINIMO o número fica escondido (um "0 online" só afasta)
    const mostra = (n: number | null): n is number => n !== null && n >= ONLINE_MINIMO;
    onlineHead.textContent = mostra(online) ? `${fmtInt(online)} ${naSala ? 'na sala' : 'online'}` : '';
    // trilho e botão flutuante mostram o total do chat (todas as salas)
    const total = tela === 'sala' && ultimoEstado ? ultimoEstado.online : online;
    railOnline.textContent = mostra(total) ? `${fmtInt(total)} online` : '';
    fabOnline.textContent = mostra(total) ? `· ${fmtInt(total)} online` : '';
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
    if (viewportLigado) ajustarViewport();
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
    if (!u.searchParams.has(RETORNO_PARAM) && !u.searchParams.has(LOGIN_PARAM)) return;
    u.searchParams.delete(RETORNO_PARAM);
    u.searchParams.delete(LOGIN_PARAM);
    history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
  };

  /** Link de acesso por e-mail: troca o token de uso único por uma sessão e entra na sala. */
  const concluirLogin = async (tok: string) => {
    mostrar('aguardando');
    if (aguardandoTxt) aguardandoTxt.textContent = 'entrando na sua conta…';
    if (!mq.matches) abrir(true);
    try {
      const a = await entrar(tok);
      const sessao = sessaoDe(a);
      guardarSessao(sessao);
      limparUrl();
      if (a.pago === false) {
        entrarSemPagar(sessao);
        return;
      }
      mostrar('sala', sessao);
      for (const cb of ouvintesSessao) cb(sessao);
    } catch (e) {
      limparUrl();
      mostrar('paywall');
      paywall.aviso(e instanceof ChatHttpError && e.status === 410 ? 'Esse link de acesso já foi usado ou venceu. Peça um novo em "Já pagou? Entrar com o e-mail".' : 'Não foi possível entrar agora. Tente de novo em instantes.');
    }
  };

  const concluirPagamento = async (ref: string) => {
    mostrar('aguardando');
    if (!mq.matches) abrir(true);
    let tentativas = 0;
    for (;;) {
      try {
        const a = await acesso(ref);
        const sessao = sessaoDe(a);
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
  const params = new URL(location.href).searchParams;
  const ref = params.get(RETORNO_PARAM);
  const loginTok = params.get(LOGIN_PARAM);
  const sessao = lerSessao();
  if (ref) void concluirPagamento(ref);
  else if (loginTok) void concluirLogin(loginTok);
  else if (sessao && sessao.pago === false) entrarSemPagar(sessao);
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
