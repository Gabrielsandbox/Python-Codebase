// Paywall do chat: preço, o que inclui, apelido e botão de pagamento.

import { el, fmtInt } from '../format';
import { apelidoValido, ChatHttpError, checkout, normalizarApelido, type Estado } from './client';

export interface Paywall {
  raiz: HTMLElement;
  setEstado(e: Estado | null, online: number | null): void;
  aviso(msg: string | null): void;
}

const fmtPreco = (centavos: number): string => {
  const inteiro = centavos % 100 === 0;
  return 'R$ ' + (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: inteiro ? 0 : 2, maximumFractionDigits: 2 });
};

export function montarPaywall(opts: { aoCheckout: () => void }): Paywall {
  let preco = 500;
  const precoEl = el('span', { class: 'pay-price num', text: fmtPreco(preco) });
  const btnTxt = el('span', { text: `Pagar ${fmtPreco(preco)} e entrar` });
  const onlineEl = el('p', { class: 'pay-online' });
  const avisoEl = el('p', { class: 'pay-aviso', role: 'alert', hidden: true });
  const erroApelido = el('span', { class: 'field-err', id: 'apelido-err', hidden: true });

  let apelidoInicial = '';
  try {
    apelidoInicial = localStorage.getItem('chat_apelido') ?? '';
  } catch {
    /* sem armazenamento */
  }
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
    { class: 'pay-form', novalidate: true },
    el(
      'div',
      { class: 'field-wrap' },
      el('label', { for: 'chat-apelido', text: 'Seu apelido' }),
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
    if (enviando || !validar(true)) {
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
      const r = await checkout(apelido, retorno.toString());
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
      } else aviso('Não foi possível iniciar o pagamento. Verifique a conexão e tente de novo.');
    }
  });

  const raiz = el(
    'section',
    { class: 'pay', 'aria-labelledby': 'pay-titulo' },
    el('span', { class: 'pay-eyebrow' }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), 'Chat ao vivo'),
    el('h3', { id: 'pay-titulo', text: 'Comente a apuração em tempo real' }),
    el('p', { class: 'pay-lead', text: 'Uma sala só, com placar atualizado no meio da conversa e moderação automática.' }),
    el(
      'div',
      { class: 'pay-price-row' },
      precoEl,
      el('span', { class: 'pay-terms' }, el('b', { text: 'pagamento único' }), el('span', { text: 'PIX ou cartão' })),
    ),
    el(
      'ul',
      { class: 'pay-list' },
      item('Vale para toda a apuração', 'do início da totalização até o resultado final'),
      item('Placar no chat', 'o sistema avisa quando o resultado muda'),
      item('Sem assinatura', 'nada é renovado nem cobrado de novo'),
    ),
    form,
    avisoEl,
    onlineEl,
    el('p', { class: 'pay-legal', text: 'Pagamento processado pela Stripe. Mensagens passam por filtro de palavras e limite de ritmo.' }),
  );

  function aviso(msg: string | null) {
    avisoEl.hidden = !msg;
    avisoEl.textContent = msg ?? '';
  }

  return {
    raiz,
    aviso,
    setEstado(e, online) {
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
      if (n !== null) {
        onlineEl.append(el('i', { class: 'live-dot', 'aria-hidden': 'true' }), el('b', { class: 'num', text: fmtInt(n) }), n === 1 ? ' pessoa no chat agora' : ' pessoas no chat agora');
      }
    },
  };
}

function item(titulo: string, desc: string): HTMLElement {
  return el('li', {}, el('i', { class: 'check', 'aria-hidden': 'true' }), el('span', {}, el('b', { text: titulo }), el('span', { class: 'desc', text: desc })));
}
