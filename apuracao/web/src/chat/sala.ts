// Sala do chat: lista de mensagens (virtualização leve), autoscroll, compositor e avisos.

import { el, fmtHora } from '../format';
import { ChatSocket, MAX_TEXTO, type Conexao, type MsgChat, type MsgServidor, type MsgSistema, type Sessao } from './client';

const MAX_DOM = 300; // mensagens mantidas no DOM
const MAX_IDS = 600; // ids lembrados para deduplicar histórico em reconexões
const LIMIAR_FUNDO = 48; // px: até aqui conta como "colado no fim"
const TRAVA_ENVIO_MS = 1500;

export interface Sala {
  raiz: HTMLElement;
  ligar(sessao: Sessao): void;
  desligar(): void;
  readonly conectado: boolean;
}

export interface SalaOpts {
  aoPresenca: (online: number) => void;
  aoConexao: (estado: Conexao) => void;
  aoExpirar: () => void;
  /** Usuário pediu para sair (apaga a sessão local). */
  aoSair: () => void;
}

export function montarSala(opts: SalaOpts): Sala {
  const lista = el('div', { class: 'chat-msgs', role: 'log', 'aria-label': 'Mensagens', tabindex: 0 });
  const vazio = el('p', { class: 'chat-vazio', text: 'Ninguém falou ainda. Seja a primeira pessoa a comentar!' });
  const scroller = el('div', { class: 'chat-scroll' }, lista);
  const pill = el('button', { class: 'chat-pill', type: 'button', hidden: true }, el('span', { text: '↓ novas mensagens' }));
  const toast = el('div', { class: 'chat-toast', role: 'status', hidden: true });

  const input = el('textarea', {
    class: 'chat-input',
    rows: 1,
    maxlength: MAX_TEXTO,
    placeholder: 'Escreva uma mensagem…',
    'aria-label': 'Mensagem',
    autocomplete: 'off',
    enterkeyhint: 'send',
    'data-foco': true,
  });
  const contador = el('span', { class: 'chat-count num', 'aria-live': 'off', text: `0/${MAX_TEXTO}` });
  const btnEnviar = el('button', { class: 'chat-send', type: 'submit', 'aria-label': 'Enviar' }, iconeEnviar());
  const dica = el('span', { class: 'chat-dica', text: 'Enter envia · Shift+Enter quebra linha' });
  const quem = el('span', { class: 'chat-quem' });
  const btnSair = el('button', { class: 'chat-sair', type: 'button', text: 'sair', title: 'Sair do chat neste navegador' });
  btnSair.addEventListener('click', () => opts.aoSair());
  const form = el(
    'form',
    { class: 'chat-compose' },
    el('div', { class: 'chat-compose-row' }, input, btnEnviar),
    el('div', { class: 'chat-compose-foot' }, quem, btnSair, dica, contador),
  );

  const raiz = el('div', { class: 'chat-sala' }, scroller, pill, toast, form);

  // ---------------------------------------------------------------- estado
  let socket: ChatSocket | null = null;
  let presoAoFim = true;
  let naoLidas = 0;
  let podarPendente = false;
  let travaEnvio: number | null = null;
  let toastTimer: number | null = null;
  const ids: string[] = [];
  const idsSet = new Set<string>();

  const lembrarId = (id: string): boolean => {
    if (idsSet.has(id)) return false;
    idsSet.add(id);
    ids.push(id);
    if (ids.length > MAX_IDS) idsSet.delete(ids.shift()!);
    return true;
  };

  // ---------------------------------------------------------------- rolagem
  const noFim = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= LIMIAR_FUNDO;
  const irAoFim = (suave = false) => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: suave ? 'smooth' : 'auto' });
    naoLidas = 0;
    pill.hidden = true;
  };
  scroller.addEventListener('scroll', () => {
    presoAoFim = noFim();
    if (presoAoFim) {
      naoLidas = 0;
      pill.hidden = true;
      if (podarPendente) podar();
    }
  });
  pill.addEventListener('click', () => irAoFim(true));

  const podar = () => {
    if (!presoAoFim) {
      podarPendente = true;
      return;
    }
    podarPendente = false;
    while (lista.children.length > MAX_DOM) lista.firstElementChild!.remove();
  };

  const anexar = (no: HTMLElement) => {
    vazio.remove();
    const colado = presoAoFim;
    lista.append(no);
    podar();
    if (colado) irAoFim();
    else {
      naoLidas++;
      pill.firstElementChild!.textContent = naoLidas > 1 ? `↓ ${naoLidas} novas mensagens` : '↓ nova mensagem';
      pill.hidden = false;
    }
  };

  // ---------------------------------------------------------------- render
  const noMsg = (m: MsgChat): HTMLElement => {
    const hora = el('time', { class: 'm-time num', datetime: m.t, text: horaSegura(m.t) });
    const cabeca = el('div', { class: 'm-head' }, m.eu ? el('span', { class: 'm-nick', text: 'você' }) : el('span', { class: 'm-nick', text: m.apelido }), hora);
    // texto SEMPRE por textContent — nunca innerHTML
    const corpo = el('div', { class: 'm-text' });
    corpo.textContent = m.texto;
    return el('article', { class: `m${m.eu ? ' eu' : ''}`, 'data-id': m.id }, cabeca, corpo);
  };
  const noSistema = (m: MsgSistema): HTMLElement => {
    const txt = el('span', { class: 's-text' });
    txt.textContent = m.texto;
    return el('div', { class: 'm-sys', role: 'note' }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), txt, el('time', { class: 'num', datetime: m.t, text: horaSegura(m.t) }));
  };

  const mostrarToast = (txt: string, tom: 'erro' | 'info' = 'erro') => {
    toast.textContent = txt;
    toast.dataset.tom = tom;
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 3200);
  };

  const aoMensagem = (m: MsgServidor) => {
    switch (m.tipo) {
      case 'historico': {
        const novas = (m.mensagens ?? []).filter((x) => x && x.tipo === 'msg' && typeof x.id === 'string' && lembrarId(x.id));
        if (novas.length) {
          vazio.remove();
          const frag = document.createDocumentFragment();
          for (const x of novas) frag.append(noMsg(x));
          lista.append(frag);
          podar();
          irAoFim();
        } else if (!lista.children.length) lista.append(vazio);
        break;
      }
      case 'msg':
        if (typeof m.id !== 'string' || !lembrarId(m.id)) return;
        anexar(noMsg(m));
        if (m.eu) destravar();
        break;
      case 'sistema':
        anexar(noSistema(m));
        break;
      case 'presenca':
        if (typeof m.online === 'number') opts.aoPresenca(m.online);
        break;
      case 'erro':
        destravar();
        mostrarToast(
          m.codigo === 'rate_limit'
            ? 'Calma! Uma mensagem a cada 2 segundos.'
            : m.codigo === 'bloqueado'
              ? 'Mensagem bloqueada pelo filtro de palavras.'
              : m.codigo === 'texto_invalido'
                ? 'Mensagem vazia ou longa demais.'
                : String(m.texto || 'Não foi possível enviar.'),
        );
        break;
    }
  };

  // ---------------------------------------------------------------- compositor
  const atualizarContador = () => {
    const n = input.value.length;
    contador.textContent = `${n}/${MAX_TEXTO}`;
    contador.classList.toggle('warn', n >= MAX_TEXTO - 20);
    contador.classList.toggle('over', n > MAX_TEXTO);
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  };
  input.addEventListener('input', atualizarContador);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  const travar = () => {
    btnEnviar.disabled = true;
    form.classList.add('enviando');
    if (travaEnvio) clearTimeout(travaEnvio);
    travaEnvio = window.setTimeout(destravar, TRAVA_ENVIO_MS);
  };
  function destravar() {
    if (travaEnvio) clearTimeout(travaEnvio);
    travaEnvio = null;
    btnEnviar.disabled = false;
    form.classList.remove('enviando');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const texto = input.value.replace(/\s+$/g, '').trim();
    if (!texto) return;
    if (texto.length > MAX_TEXTO) {
      mostrarToast(`A mensagem pode ter até ${MAX_TEXTO} caracteres.`);
      return;
    }
    if (btnEnviar.disabled) return;
    if (!socket?.enviar(texto)) {
      mostrarToast('Sem conexão com o chat. Tentando reconectar…');
      return;
    }
    travar();
    input.value = '';
    atualizarContador();
    input.focus();
  });

  // ---------------------------------------------------------------- ciclo de vida
  const sala: Sala = {
    raiz,
    get conectado() {
      return !!socket?.aberto;
    },
    ligar(s) {
      sala.desligar();
      quem.textContent = s.apelido ? `como ${s.apelido}` : '';
      lista.replaceChildren(vazio);
      ids.length = 0;
      idsSet.clear();
      presoAoFim = true;
      naoLidas = 0;
      pill.hidden = true;
      atualizarContador();
      socket = new ChatSocket(s.token, {
        onConexao: (estado, tentativa) => {
          raiz.dataset.conexao = estado;
          input.disabled = estado === 'desligado';
          opts.aoConexao(estado);
          if (estado === 'reconectando' && tentativa >= 3) mostrarToast('Sem conexão com o chat. Tentando de novo…', 'info');
        },
        onMensagem: aoMensagem,
        onExpirado: () => {
          socket = null;
          opts.aoExpirar();
        },
      });
    },
    desligar() {
      socket?.fechar();
      socket = null;
      destravar();
    },
  };
  return sala;
}

function horaSegura(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : fmtHora(d.toISOString());
}

function iconeEnviar(): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M3 10h11M10 4l6 6-6 6');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '2');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}
