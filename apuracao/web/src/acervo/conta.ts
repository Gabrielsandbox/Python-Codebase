// Conta da plataforma: criar conta / entrar pelo e-mail (link de uso único) ou Google, com a mesma
// sessão do chat (localStorage). Sem sessão a plataforma mostra o "portão": o que há dentro + o formulário.
import { el } from '../format';
import { cadastrar, ChatHttpError, contaGoogle, EMAIL_RE, entrar, GOOGLE_CLIENT_ID, guardarSessao, lerSessao, pedirLogin, type Sessao } from '../chat/client';

const LOGIN_PARAM = 'login';

export interface Conta {
  sessao: () => Sessao | null;
  /** Landing + formulário, para quem não está logado. */
  portao: () => HTMLElement;
  /** Resolve `?login=TOKEN` (link do e-mail). Devolve true se entrou agora. */
  concluirLink: () => Promise<boolean>;
}

interface GoogleId {
  accounts: { id: { initialize(cfg: Record<string, unknown>): void; renderButton(el: HTMLElement, cfg: Record<string, unknown>): void; disableAutoSelect(): void } };
}

function carregarGoogle(): Promise<GoogleId | null> {
  const w = window as unknown as { google?: GoogleId };
  if (w.google?.accounts?.id) return Promise.resolve(w.google);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(w.google ?? null);
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
}

export function montarConta(slot: HTMLElement, aoMudar: (s: Sessao | null) => void): Conta {
  let sessao = lerSessao();

  const renderSlot = () => {
    slot.replaceChildren();
    if (sessao) {
      const sair = el('button', { class: 'btn ac-sair', type: 'button', text: 'Sair' });
      sair.addEventListener('click', () => {
        sessao = null;
        guardarSessao(null);
        (window as unknown as { google?: GoogleId }).google?.accounts.id.disableAutoSelect();
        renderSlot();
        aoMudar(null);
      });
      slot.append(el('span', { class: 'ac-user' }, el('i', { class: 'ac-user-dot', 'aria-hidden': 'true' }), el('b', { text: sessao.apelido || sessao.email || 'você' })), sair);
    } else {
      slot.append(el('a', { class: 'btn ac-entrar', href: '#entrar', text: 'Entrar' }));
    }
  };
  renderSlot();

  const entrou = (s: Sessao) => {
    sessao = s;
    guardarSessao(s);
    renderSlot();
    aoMudar(s);
  };

  const portao = (): HTMLElement => {
    let modo: 'criar' | 'entrar' = 'criar';
    const nome = el('input', { class: 'field', id: 'ac-nome', type: 'text', autocomplete: 'name', maxlength: 80, placeholder: 'Como quer ser chamado' });
    const email = el('input', { class: 'field', id: 'ac-email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254, placeholder: 'voce@exemplo.com' });
    const nomeWrap = el('div', { class: 'field-wrap' }, el('label', { for: 'ac-nome', text: 'Seu nome' }), nome);
    const btnTxt = el('span', { text: 'Criar conta grátis' });
    const btn = el('button', { class: 'btn-pay', type: 'submit' }, btnTxt);
    const msg = el('p', { class: 'pay-aviso', role: 'status', hidden: true });
    const alt = el('button', { class: 'btn-link ac-alt', type: 'button' });
    const titulo = el('h3', { text: 'Crie sua conta' });
    const aplicarModo = () => {
      nomeWrap.hidden = modo !== 'criar';
      titulo.textContent = modo === 'criar' ? 'Crie sua conta' : 'Entrar';
      btnTxt.textContent = modo === 'criar' ? 'Criar conta grátis' : 'Receber link de acesso';
      alt.textContent = modo === 'criar' ? 'Já tenho conta' : 'Ainda não tenho conta';
      msg.hidden = true;
    };
    alt.addEventListener('click', () => {
      modo = modo === 'criar' ? 'entrar' : 'criar';
      aplicarModo();
      (modo === 'criar' ? nome : email).focus();
    });
    const mostrar = (texto: string, erro = false) => {
      msg.hidden = false;
      msg.textContent = texto;
      msg.classList.toggle('ok', !erro);
    };
    const form = el('form', { class: 'pay-form ac-form', novalidate: true }, nomeWrap, el('div', { class: 'field-wrap' }, el('label', { for: 'ac-email', text: 'Seu e-mail' }), email), btn, msg, alt);
    let enviando = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (enviando) return;
      const em = email.value.trim().toLowerCase();
      if (!EMAIL_RE.test(em)) {
        mostrar('Esse e-mail não parece válido.', true);
        email.focus();
        return;
      }
      if (modo === 'criar' && nome.value.trim().length < 2) {
        mostrar('Diga como quer ser chamado (2 letras ou mais).', true);
        nome.focus();
        return;
      }
      enviando = true;
      btn.disabled = true;
      mostrar('Enviando…');
      try {
        const retorno = new URL(location.href);
        retorno.search = '';
        retorno.hash = '';
        const r = modo === 'criar' ? await cadastrar(em, nome.value.trim(), retorno.toString()) : await pedirLogin(em, retorno.toString());
        if (r.link) {
          // servidor sem e-mail configurado (desenvolvimento): o link vem na resposta
          const tok = new URL(r.link).searchParams.get(LOGIN_PARAM);
          if (tok) {
            const a = await entrar(tok);
            entrou({ token: a.token, apelido: a.apelido, autor: a.autor, email: a.email, pago: a.pago });
            return;
          }
        }
        mostrar(`Enviamos um link de acesso para ${em}. Ele vale por 30 minutos e abre em qualquer aparelho. Confira também a caixa de spam.`);
      } catch (err) {
        if (err instanceof ChatHttpError && err.status === 404 && modo === 'criar') {
          mostrar('Criar conta ainda não está disponível neste servidor. Tente "Já tenho conta".', true);
        } else if (err instanceof ChatHttpError && err.status === 422) mostrar('Esse e-mail não foi aceito. Confira e tente de novo.', true);
        else mostrar('Não foi possível enviar agora. Tente de novo em instantes.', true);
      } finally {
        enviando = false;
        btn.disabled = false;
      }
    });
    aplicarModo();

    const googleDiv = el('div', { class: 'pay-google', hidden: !GOOGLE_CLIENT_ID });
    if (GOOGLE_CLIENT_ID) {
      void carregarGoogle().then((g) => {
        if (!g) return;
        g.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (r: { credential: string }) => {
            void contaGoogle(r.credential)
              .then((a) => entrou({ token: a.token, apelido: a.apelido, autor: a.autor, email: a.email, pago: a.pago }))
              .catch(() => mostrar('O Google não confirmou sua conta. Tente pelo e-mail.', true));
          },
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true,
        });
        g.accounts.id.renderButton(googleDiv, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', locale: 'pt-BR', width: Math.max(200, Math.min(400, googleDiv.clientWidth || 320)) });
      });
    }

    return el(
      'section',
      { class: 'ac-portao', 'aria-label': 'Entrar na plataforma' },
      el(
        'div',
        { class: 'card ac-card ac-portao-sobre' },
        el('span', { class: 'pay-eyebrow', text: 'Plataforma de dados' }),
        el('h2', { text: 'A política brasileira dos últimos anos, em números' }),
        el('p', { class: 'ac-lead', text: 'Resultados oficiais do TSE, histórico de cada candidato e pesquisas num só lugar. Grátis, com conta.' }),
        el(
          'ul',
          { class: 'pay-list' },
          item('Eleições passadas', 'vencedores, participação, votos por candidato e por estado'),
          item('Histórico de candidatos', 'todas as candidaturas de uma pessoa, com partido, votos e resultado'),
          item('Pesquisas centralizadas', 'a evolução de cada candidato ao longo da campanha'),
        ),
      ),
      el('div', { class: 'card ac-card ac-portao-form' }, titulo, googleDiv, GOOGLE_CLIENT_ID ? el('p', { class: 'ac-ou', text: 'ou pelo e-mail' }) : null, form, el('p', { class: 'pay-legal', text: 'Sem senha: você entra pelo link que mandamos no e-mail. A mesma conta vale para o chat da apuração.' })),
    );
  };

  const concluirLink = async (): Promise<boolean> => {
    const u = new URL(location.href);
    const tok = u.searchParams.get(LOGIN_PARAM);
    if (!tok) return false;
    u.searchParams.delete(LOGIN_PARAM);
    history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
    try {
      const a = await entrar(tok);
      entrou({ token: a.token, apelido: a.apelido, autor: a.autor, email: a.email, pago: a.pago });
      return true;
    } catch {
      return false;
    }
  };

  return { sessao: () => sessao, portao, concluirLink };
}

function item(titulo: string, desc: string): HTMLElement {
  return el('li', {}, el('i', { class: 'check', 'aria-hidden': 'true' }), el('span', {}, el('b', { text: titulo }), el('span', { class: 'desc', text: ' · ' + desc })));
}
