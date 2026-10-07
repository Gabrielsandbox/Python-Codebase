// Prévia ao vivo da sala atrás do paywall: feed somente leitura (GET /chat/previa a cada 5 s),
// com a MESMA marcação da sala (.chat-msgs / .m / .m-sys) para o desfoque parecer a sala real.
// Texto só via textContent. Para quando o painel está fechado ou a aba oculta.

import { el, fmtHora, fmtInt } from '../format';
import { previa as lerPrevia, type MsgPrevia, ONLINE_MINIMO } from './client';

const INTERVALO = 5_000;
const MAX_VISIVEIS = 12;

export interface PreviaFeed {
  raiz: HTMLElement;
  /** Começa a atualizar (idempotente). */
  ligar(): void;
  desligar(): void;
  /** Último "online" conhecido (null antes da 1ª resposta). */
  readonly online: number | null;
  /** Chamado a cada resposta bem-sucedida. */
  aoAtualizar?: (online: number, mensagens: number) => void;
}

export function montarPrevia(): PreviaFeed {
  const online = el('div', { class: 'm-sys previa-online', role: 'note' }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), el('span', { class: 's-text' }));
  const onlineTxt = online.lastElementChild as HTMLElement;
  const lista = el('div', { class: 'chat-msgs' }, online);
  const scroller = el('div', { class: 'chat-scroll' }, lista);
  const vazio = el('p', { class: 'chat-vazio', text: 'A conversa começa assim que a totalização abrir.' });
  // aria-hidden: é decoração atrás do cartão; o conteúdo real fica acessível depois de entrar
  const raiz = el('div', { class: 'chat-previa', 'aria-hidden': 'true' }, scroller);

  let timer: number | null = null;
  let ligado = false;
  let emCurso = false;
  let ultimoOnline: number | null = null;
  const chaves = new Set<string>();

  const chave = (m: MsgPrevia) => `${m.tipo}|${m.t}|${m.apelido ?? ''}|${m.texto}`;

  const noMsg = (m: MsgPrevia): HTMLElement => {
    const corpo = el('div', { class: 'm-text' });
    corpo.textContent = m.texto;
    return el(
      'article',
      { class: 'm' },
      el('div', { class: 'm-head' }, el('span', { class: 'm-nick', text: m.apelido || 'anônimo' }), el('time', { class: 'm-time num', datetime: m.t, text: horaSegura(m.t) })),
      corpo,
    );
  };
  const noSistema = (m: MsgPrevia): HTMLElement => {
    const txt = el('span', { class: 's-text' });
    txt.textContent = m.texto;
    return el('div', { class: 'm-sys', role: 'note' }, el('i', { class: 'live-dot', 'aria-hidden': 'true' }), txt, el('time', { class: 'num', datetime: m.t, text: horaSegura(m.t) }));
  };

  const render = (msgs: MsgPrevia[], n: number) => {
    ultimoOnline = n;
    online.hidden = n < ONLINE_MINIMO; // poucos online: não anuncia
    onlineTxt.textContent = n === 1 ? '1 pessoa conversando agora' : `${fmtInt(n)} pessoas conversando agora`;
    const visiveis = msgs.filter((m) => m && typeof m.texto === 'string').slice(-MAX_VISIVEIS);
    const novas = new Set<string>();
    const nos: HTMLElement[] = [online];
    for (const m of visiveis) {
      const k = chave(m);
      const no = m.tipo === 'sistema' ? noSistema(m) : noMsg(m);
      if (chaves.size && !chaves.has(k)) no.classList.add('nova'); // chegou neste ciclo: entra com fade
      novas.add(k);
      nos.push(no);
    }
    if (!visiveis.length) nos.push(vazio);
    chaves.clear();
    for (const k of novas) chaves.add(k);
    lista.replaceChildren(...nos);
    scroller.scrollTop = scroller.scrollHeight;
  };

  const tique = async () => {
    if (!ligado || emCurso || document.visibilityState !== 'visible') return;
    emCurso = true;
    try {
      const p = await lerPrevia('geral');
      render(Array.isArray(p.mensagens) ? p.mensagens : [], typeof p.online === 'number' ? p.online : 0);
      feed.aoAtualizar?.(p.online, p.mensagens?.length ?? 0);
    } catch {
      /* o feed é decorativo: sem servidor, fica como está */
    } finally {
      emCurso = false;
    }
  };

  const aoVisibilidade = () => {
    if (document.visibilityState === 'visible') void tique();
  };

  const feed: PreviaFeed = {
    raiz,
    get online() {
      return ultimoOnline;
    },
    ligar() {
      if (ligado) return;
      ligado = true;
      document.addEventListener('visibilitychange', aoVisibilidade);
      void tique();
      timer = window.setInterval(() => void tique(), INTERVALO);
    },
    desligar() {
      if (!ligado) return;
      ligado = false;
      document.removeEventListener('visibilitychange', aoVisibilidade);
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return feed;
}

function horaSegura(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : fmtHora(d.toISOString());
}
