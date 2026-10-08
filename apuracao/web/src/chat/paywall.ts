// Paywall do chat: 1) entrar com o Google (cria a conta) → 2) apelido e pagamento de R$ 5.
// Sem o client id do Google configurado, o passo 1 cai no acesso por e-mail (link de uso único).

import { el, fmtInt } from '../format';
import { apelidoValido, ChatHttpError, checkout, CHAVE_EMAIL, EMAIL_RE, GOOGLE_CLIENT_ID, normalizarApelido, ONLINE_MINIMO, pedirLogin, type Estado, type Sessao } from './client';

export type VariantePaywall = 'chat' | 'telao';

export interface Paywall {
  raiz: HTMLElement;
  setEstado(e: Estado | null, online: number | null): void;
  aviso(msg: string | null): void;
  /** 'telao': manchete "Chat ao vivo + modo telão" e a nota "Depois de pagar, o telão abre sozinho". */
  setVariante(v: VariantePaywall): void;
  readonly variante: VariantePaywall;
  /** Conta logada (Google ou e-mail) ou null. Com conta, mostra só apelido + pagar. */
  setConta(s: Sessao | null): void;
}

export interface PaywallOpts {
  aoCheckout: () => void;
  /** Credencial do Google (ou "dev:…" em desenvolvimento) → o chamador cria a sessão. */
  aoGoogle: (credential: string) => Promise<void>;
  /** "trocar de conta": apaga a sessão local. */
  aoTrocarConta: () => void;
}

interface GoogleId {
  accounts: {
    id: {
      initialize(cfg: Record<string, unknown>): void;
      renderButton(el: HTMLElement, cfg: Record<string, unknown>): void;
      disableAutoSelect(): void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleId;
  }
}

const fmtPreco = (centavos: number): string => {
  const inteiro = centavos % 100 === 0;
  return 'R$ ' + (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: inteiro ? 0 : 2, maximumFractionDigits: 2 });
};

let gisCarregando: Promise<GoogleId | null> | null = null;
/** Carrega o script do Google Identity Services uma vez (só quando o paywall precisa). */
function carregarGoogle(): Promise<GoogleId | null> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (!gisCarregando) {
    gisCarregando = new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => resolve(window.google ?? null);
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
  }
  return gisCarregando;
}

export function montarPaywall(opts: PaywallOpts): Paywall {
  let preco = 500;
  let variante: VariantePaywall = 'chat';
  let conta: Sessao | null = null;
  let provedor = '';
  const precoEl = el('span', { class: 'pay-price num', text: fmtPreco(preco) });
  const titulo = el('h3', { id: 'pay-titulo', text: 'Entre na conversa' });
  const lead = el('p', { class: 'pay-lead', text: 'Comente a apuração em tempo real com quem está acompanhando agora.' });
  const notaTelao = el('p', { class: 'pay-telao-nota', hidden: true }, el('i', { class: 'ico', 'aria-hidden': 'true' }), el('span', { text: 'Depois de pagar, o telão abre sozinho' }));
  const btnTxt = el('span', { text: `Pagar ${fmtPreco(preco)} e entrar` });
  const onlineEl = el('p', { class: 'pay-online' });
  const avisoEl = el('p', { class: 'pay-aviso', role: 'alert', hidden: true });
  const erroApelido = el('span', { class: 'field-err', id: 'apelido-err', hidden: true });

  let apelidoInicial = '';
  let emailInicial = '';
  try {
    apelidoInicial = localStorage.getItem('chat_apelido') ?? '';
    emailInicial = localStorage.getItem(CHAVE_EMAIL) ?? '';
  } catch {
    /* sem armazenamento */
  }

  // ---------------------------------------------------------------- passo 1: entrar (Google)
  const googleDiv = el('div', { class: 'pay-google' });
  const googleFalha = el('p', { class: 'pay-login-msg', hidden: true, text: 'Não foi possível carregar o botão do Google. Use o acesso por e-mail abaixo.' });
  const devBtn = el('button', { class: 'btn btn-dev', type: 'button', hidden: true, text: 'Entrar (modo de teste)' });
  devBtn.addEventListener('click', () => {
    let email = '';
    try {
      email = localStorage.getItem(CHAVE_EMAIL) ?? '';
    } catch {
      /* sem armazenamento */
    }
    void opts.aoGoogle(`dev:${email || 'teste@exemplo.test'}:Teste`);
  });
  const entrandoEl = el('p', { class: 'pay-login-msg', hidden: true, text: 'Entrando…' });

  // acesso por e-mail (link de uso único): alternativa a quem não tem Google
  const loginEmail = el('input', { class: 'field', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254, placeholder: 'seu e-mail', 'aria-label': 'E-mail da conta', value: emailInicial });
  const loginBtn = el('button', { class: 'btn btn-login', type: 'submit', text: 'Enviar link de acesso' });
  const loginMsg = el('p', { class: 'pay-login-msg', role: 'status', hidden: true });
  const loginForm = el('form', { class: 'pay-login-form', novalidate: true, hidden: true }, loginEmail, loginBtn, loginMsg);
  const loginToggle = el('button', { class: 'btn-link pay-login-toggle', type: 'button', text: 'Prefiro entrar com o e-mail' });
  loginToggle.addEventListener('click', () => {
    loginForm.hidden = !loginForm.hidden;
    if (!loginForm.hidden) loginEmail.focus();
  });
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = loginEmail.value.trim();
    if (!EMAIL_RE.test(v)) {
      loginMsg.hidden = false;
      loginMsg.textContent = 'Esse e-mail não parece válido.';
      return;
    }
    loginBtn.disabled = true;
    loginMsg.hidden = false;
    loginMsg.textContent = 'Enviando…';
    try {
      localStorage.setItem(CHAVE_EMAIL, v.toLowerCase());
    } catch {
      /* sem armazenamento */
    }
    try {
      const retorno = new URL(location.href);
      retorno.search = '';
      retorno.hash = '';
      const r = await pedirLogin(v, retorno.toString());
      if (r.link) {
        location.assign(r.link); // desenvolvimento sem e-mail configurado
        return;
      }
      loginMsg.textContent = 'Se esse e-mail tem conta, enviamos um link de acesso. Ele vale por 30 minutos e abre em qualquer aparelho.';
    } catch {
      loginMsg.textContent = 'Não foi possível enviar agora. Tente de novo em instantes.';
    } finally {
      loginBtn.disabled = false;
    }
  });

  const blocoEntrar = el(
    'div',
    { class: 'pay-entrar' },
    el('p', { class: 'pay-passo', text: 'Entre com o Google para criar sua conta. Você fica logado e entra de novo em qualquer aparelho.' }),
    googleDiv,
    googleFalha,
    devBtn,
    entrandoEl,
    el('div', { class: 'pay-login' }, loginToggle, loginForm),
  );

  let gisPronto = false;
  const prepararGoogle = async () => {
    if (gisPronto || !GOOGLE_CLIENT_ID) return;
    gisPronto = true;
    const g = await carregarGoogle();
    if (!g) {
      googleFalha.hidden = false;
      loginForm.hidden = false;
      return;
    }
    g.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (r: { credential: string }) => {
        entrandoEl.hidden = false;
        void opts.aoGoogle(r.credential).finally(() => (entrandoEl.hidden = true));
      },
      ux_mode: 'popup',
      auto_select: false,
      itp_support: true,
      use_fedcm_for_prompt: true,
    });
    const largura = Math.max(200, Math.min(400, googleDiv.clientWidth || 320));
    g.accounts.id.renderButton(googleDiv, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'left', locale: 'pt-BR', width: largura });
  };

  // ---------------------------------------------------------------- passo 2: apelido + pagar
  const contaNome = el('b');
  const contaEmail = el('span', { class: 'pay-conta-email' });
  const trocar = el('button', { class: 'btn-link', type: 'button', text: 'trocar' });
  trocar.addEventListener('click', () => opts.aoTrocarConta());
  const contaLinha = el('p', { class: 'pay-conta' }, el('i', { class: 'check', 'aria-hidden': 'true' }), el('span', {}, 'Conectado como ', contaNome, ' ', contaEmail), ' · ', trocar);

  const input = el('input', {
    class: 'field',
    id: 'chat-apelido',
    type: 'text',
    autocomplete: 'nickname',
    maxlength: 24,
    minlength: 2,
    spellcheck: false,
    placeholder: 'ex.: Maria_SP',
    'aria-describedby': 'apelido-hint apelido-err',
    'data-foco': true,
    value: apelidoInicial,
  });
  const btn = el('button', { class: 'btn-pay', type: 'submit' }, btnTxt);

  const validar = (mostrar: boolean): boolean => {
    const v = normalizarApelido(input.value);
    let erro: string | null = null;
    if (v.length === 0) erro = 'Escolha um apelido para aparecer no chat.';
    else if (v.length < 2) erro = 'O apelido precisa ter pelo menos 2 caracteres.';
    else if (v.length > 24) erro = 'O apelido pode ter no máximo 24 caracteres.';
    else if (!apelidoValido(v)) erro = 'Use só letras, números, espaço ou _.';
    if (mostrar || input.dataset.tocado) {
      erroApelido.hidden = !erro;
      erroApelido.textContent = erro ?? '';
      input.setAttribute('aria-invalid', erro ? 'true' : 'false');
      input.classList.toggle('invalid', !!erro);
    }
    return !erro;
  };
  input.addEventListener('input', () => {
    aviso(null);
    validar(false);
  });
  input.addEventListener('blur', () => {
    input.dataset.tocado = '1';
    validar(false);
  });

  const form = el(
    'form',
    { class: 'pay-form', novalidate: true, hidden: true },
    contaLinha,
    el(
      'div',
      { class: 'field-wrap' },
      el('label', { for: 'chat-apelido', text: 'Seu apelido no chat' }),
      input,
      el('span', { class: 'field-hint', id: 'apelido-hint', text: '2 a 24 caracteres: letras, números, espaço ou _' }),
      erroApelido,
    ),
    btn,
  );

  let enviando = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    input.dataset.tocado = '1';
    if (enviando || !conta || !validar(true)) {
      input.focus();
      return;
    }
    enviando = true;
    btn.disabled = true;
    btnTxt.textContent = 'Abrindo pagamento…';
    aviso(null);
    const apelido = normalizarApelido(input.value);
    try {
      localStorage.setItem('chat_apelido', apelido);
    } catch {
      /* sem armazenamento */
    }
    try {
      const retorno = new URL(location.href);
      retorno.search = '';
      retorno.hash = '';
      const r = await checkout(apelido, retorno.toString(), { token: conta.token });
      opts.aoCheckout();
      location.assign(r.url);
    } catch (err) {
      enviando = false;
      btn.disabled = false;
      btnTxt.textContent = `Pagar ${fmtPreco(preco)} e entrar`;
      if (err instanceof ChatHttpError && (err.status === 400 || err.status === 422)) {
        erroApelido.hidden = false;
        erroApelido.textContent = 'Apelido recusado pelo servidor. Tente outro.';
        input.setAttribute('aria-invalid', 'true');
        input.classList.add('invalid');
      } else if (err instanceof ChatHttpError && err.status === 401) {
        aviso('Sua sessão expirou. Entre de novo.');
        opts.aoTrocarConta();
      } else aviso('Não foi possível iniciar o pagamento. Verifique a conexão e tente de novo.');
    }
  });

  const raiz = el(
    'section',
    { class: 'pay', 'aria-labelledby': 'pay-titulo' },
    el('span', { class: 'pay-eyebrow' }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), 'Chat ao vivo'),
    titulo,
    lead,
    notaTelao,
    // texto exato: "R$ 5 · pagamento único · PIX ou cartão"
    el('p', { class: 'pay-price-row num' }, precoEl, el('span', { class: 'pay-terms', text: ' · pagamento único · PIX ou cartão' })),
    el(
      'ul',
      { class: 'pay-list' },
      item('Chat ao vivo durante toda a apuração'),
      item('Modo telão (TV) para bar, redação e sala de aula'),
      item('Salas por estado, reações e termômetro da torcida'),
    ),
    blocoEntrar,
    form,
    avisoEl,
    onlineEl,
    el('p', { class: 'pay-legal', text: 'Pagamento processado pela Stripe. Mensagens passam por filtro de palavras e limite de ritmo.' }),
  );

  function aviso(msg: string | null) {
    avisoEl.hidden = !msg;
    avisoEl.textContent = msg ?? '';
  }

  const renderConta = () => {
    const logado = !!conta;
    blocoEntrar.hidden = logado;
    form.hidden = !logado;
    if (conta) {
      contaNome.textContent = conta.apelido || conta.email || '';
      contaEmail.textContent = conta.email ? `(${conta.email})` : '';
      if (!input.value && conta.apelido) input.value = conta.apelido;
    } else {
      devBtn.hidden = !(provedor === 'dev' && !GOOGLE_CLIENT_ID);
      if (!GOOGLE_CLIENT_ID) loginForm.hidden = false; // sem Google configurado: e-mail à vista
      void prepararGoogle();
    }
  };
  renderConta();

  return {
    raiz,
    aviso,
    get variante() {
      return variante;
    },
    setVariante(v) {
      variante = v;
      raiz.dataset.variante = v;
      titulo.textContent = v === 'telao' ? 'Chat ao vivo + modo telão' : 'Entre na conversa';
      lead.textContent =
        v === 'telao'
          ? 'O telão faz parte do pacote: placar gigante e mapa em tela cheia, mais o chat ao vivo.'
          : 'Comente a apuração em tempo real com quem está acompanhando agora.';
      notaTelao.hidden = v !== 'telao';
    },
    setConta(s) {
      conta = s;
      renderConta();
    },
    setEstado(e, online) {
      if (e?.provedor && e.provedor !== provedor) {
        provedor = e.provedor;
        renderConta();
      }
      if (e && e.preco_centavos !== preco) {
        preco = e.preco_centavos;
        precoEl.textContent = fmtPreco(preco);
        if (!enviando) btnTxt.textContent = `Pagar ${fmtPreco(preco)} e entrar`;
      }
      if (e && !e.aberto) {
        btn.disabled = true;
        btnTxt.textContent = 'Chat fechado no momento';
      } else if (!enviando) btn.disabled = false;
      const n = online ?? e?.online ?? null;
      onlineEl.replaceChildren();
      if (n !== null && n >= ONLINE_MINIMO) {
        onlineEl.append(el('i', { class: 'live-dot', 'aria-hidden': 'true' }), el('b', { class: 'num', text: fmtInt(n) }), n === 1 ? ' pessoa conversando agora' : ' pessoas conversando agora');
      }
    },
  };
}

function item(titulo: string, desc?: string): HTMLElement {
  return el('li', {}, el('i', { class: 'check', 'aria-hidden': 'true' }), el('span', {}, el('b', { text: titulo }), desc ? el('span', { class: 'desc', text: desc }) : null));
}
