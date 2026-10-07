// Alertas (docs/ALERTAS.md): sino na barra superior → popover para ativar Web Push
// (permissão → service worker → PushManager.subscribe com a chave VAPID → POST
// /alertas/inscrever), escolher eventos e abrir o bot do Telegram.

import './alertas.css';
import { el } from '../format';

export const ALERTAS_BASE: string = (import.meta.env.VITE_ALERTAS_BASE as string | undefined)?.replace(/\/$/, '') || '/alertas';
const SW_URL = `${import.meta.env.BASE_URL}sw.js`;
const CHAVE = 'alertas_inscricao';

interface Config {
  vapid_publica: string;
  telegram_bot: string | null;
  eventos: string[];
}
interface Inscricao {
  id: string;
  endpoint: string;
  eventos: string[];
}

type Suporte = 'ok' | 'sem-sw' | 'ios-nao-instalado' | 'nao-suportado';
type Estado = 'carregando' | 'inativo' | 'ativo' | 'bloqueado' | 'nao-suportado' | 'ios' | 'processando' | 'erro';

const EVENTOS: { chave: string; rotulo: string; desc: string }[] = [
  { chave: 'virada', rotulo: 'Virada', desc: 'quando o líder nacional muda' },
  { chave: 'marcos', rotulo: 'Marcos', desc: '25, 50, 75, 90 e 100% das seções' },
  { chave: 'definido', rotulo: 'Definição', desc: 'quando o TSE define o resultado' },
  { chave: 'matematica', rotulo: 'Matematicamente definido', desc: 'quando não dá mais para virar' },
  { chave: 'inicio', rotulo: 'Início', desc: 'primeira totalização do dia' },
];
const PADRAO = ['virada', 'marcos', 'definido'];

// ------------------------------------------------------------------ utilidades
function suporte(): Suporte {
  if (typeof window === 'undefined') return 'nao-suportado';
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
  const instalado = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator)) return 'sem-sw';
  if (!('PushManager' in window) || !('Notification' in window)) return ios && !instalado ? 'ios-nao-instalado' : 'nao-suportado';
  return 'ok';
}

function base64UrlParaBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function lerInscricao(): Inscricao | null {
  try {
    const raw = localStorage.getItem(CHAVE);
    if (!raw) return null;
    const j = JSON.parse(raw) as Inscricao;
    return j && typeof j.endpoint === 'string' && Array.isArray(j.eventos) ? j : null;
  } catch {
    return null;
  }
}
function guardarInscricao(i: Inscricao | null): void {
  try {
    if (i) localStorage.setItem(CHAVE, JSON.stringify(i));
    else localStorage.removeItem(CHAVE);
  } catch {
    /* sem armazenamento */
  }
}

async function chamar<T>(caminho: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${ALERTAS_BASE}${caminho}`, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}
const lerConfig = (): Promise<Config> => chamar<Config>('/config', { cache: 'no-cache' });

let registroSW: Promise<ServiceWorkerRegistration> | null = null;
/** Registra o service worker (uma vez). Em produção, registra no carregamento para o PWA ser instalável. */
export function registrarSW(): Promise<ServiceWorkerRegistration> {
  if (!registroSW) {
    registroSW = navigator.serviceWorker.register(SW_URL, { scope: import.meta.env.BASE_URL }).catch((e) => {
      registroSW = null;
      throw e;
    });
  }
  return registroSW;
}

// ------------------------------------------------------------------ interface
export function montarAlertas(raiz: HTMLElement): void {
  const sup = suporte();
  if (sup === 'ok' && import.meta.env.PROD) void registrarSW().catch(() => undefined);

  const ponto = el('i', { class: 'al-dot', 'aria-hidden': 'true' });
  const btn = el('button', { class: 'al-bell', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Alertas da apuração', title: 'Alertas' }, iconeSino(), ponto);
  const titulo = el('h3', { id: 'al-titulo', text: 'Avisos da apuração' });
  const intro = el('p', { class: 'al-intro', text: 'Receba um aviso na virada, nos marcos (25/50/75/90/100%) e quando o TSE definir — mesmo com a aba fechada.' });
  const status = el('p', { class: 'al-status', role: 'status' });
  const lista = el('div', { class: 'al-eventos', role: 'group', 'aria-label': 'Quais avisos receber' });
  const btnPrincipal = el('button', { class: 'al-primary', type: 'button', text: 'Ativar alertas' });
  const btnDesativar = el('button', { class: 'al-link', type: 'button', text: 'desativar', hidden: true });
  const telegram = el('a', { class: 'al-telegram', target: '_blank', rel: 'noopener', hidden: true }, iconeTelegram(), el('span', { text: 'Receber no Telegram' }));
  const dica = el('p', { class: 'al-dica', hidden: true });
  const btnFechar = el('button', { class: 'al-x', type: 'button', 'aria-label': 'Fechar' }, iconeX());
  const pop = el(
    'div',
    { class: 'al-pop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'al-titulo', hidden: true },
    el('div', { class: 'al-head' }, titulo, btnFechar),
    intro,
    lista,
    el('div', { class: 'al-acoes' }, btnPrincipal, btnDesativar),
    status,
    dica,
    telegram,
  );
  const slot = el('div', { class: 'alertas' }, btn);
  // o cabeçalho é montado por ui/cabecalho.ts: entramos na área de status, se existir
  const area = document.querySelector<HTMLElement>('#topbar .topbar-inner .status');
  (area ?? raiz).append(slot);
  // o popover vive no body (a barra superior tem backdrop-filter, que prenderia um position: fixed)
  document.body.append(pop);
  const posicionar = () => {
    if (pop.hidden) return;
    if (matchMedia('(max-width: 640px)').matches) {
      pop.style.cssText = '';
      return;
    }
    const r = btn.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 10)}px`;
    pop.style.right = `${Math.max(12, Math.round(innerWidth - r.right))}px`;
  };
  addEventListener('resize', posicionar);
  addEventListener('scroll', posicionar, { passive: true });

  const caixas = new Map<string, HTMLInputElement>();
  for (const ev of EVENTOS) {
    const cb = el('input', { type: 'checkbox', value: ev.chave, id: `al-ev-${ev.chave}` });
    cb.checked = PADRAO.includes(ev.chave);
    caixas.set(ev.chave, cb);
    lista.append(el('label', { class: 'al-ev', for: cb.id }, cb, el('span', { class: 'al-ev-txt' }, el('b', { text: ev.rotulo }), el('small', { text: ev.desc }))));
  }
  const escolhidos = () => [...caixas.values()].filter((c) => c.checked).map((c) => c.value);

  let config: Config | null = null;
  let inscricao = lerInscricao();
  let estado: Estado = 'carregando';
  let aberto = false;

  const setEstado = (e: Estado, msg?: string) => {
    estado = e;
    slot.dataset.estado = e;
    btn.classList.toggle('on', e === 'ativo');
    ponto.hidden = e !== 'ativo';
    btn.title = e === 'ativo' ? 'Alertas ativados' : 'Alertas';
    const podeAtivar = e === 'inativo' || e === 'erro';
    btnPrincipal.hidden = !(podeAtivar || e === 'ativo' || e === 'processando');
    btnPrincipal.disabled = e === 'processando';
    btnPrincipal.textContent = e === 'ativo' ? 'Salvar escolha' : e === 'processando' ? 'Ativando…' : 'Ativar alertas';
    btnDesativar.hidden = e !== 'ativo';
    for (const c of caixas.values()) c.disabled = !(podeAtivar || e === 'ativo');
    lista.hidden = e === 'nao-suportado' || e === 'ios' || e === 'bloqueado';
    status.textContent =
      msg ??
      (e === 'ativo'
        ? 'Alertas ativados neste navegador.'
        : e === 'bloqueado'
          ? 'As notificações estão bloqueadas pelo navegador. Permita-as nas configurações do site para ativar.'
          : e === 'ios'
            ? 'No iPhone/iPad, os avisos só funcionam com o site instalado.'
            : e === 'nao-suportado'
              ? 'Este navegador não suporta notificações push.'
              : e === 'carregando'
                ? 'Verificando…'
                : '');
    status.dataset.tom = e === 'bloqueado' || e === 'erro' ? 'erro' : e === 'ativo' ? 'ok' : '';
    dica.hidden = e !== 'ios';
    if (e === 'ios') dica.textContent = 'Toque em Compartilhar e em "Adicionar à Tela de Início"; depois abra o app e volte aqui.';
  };

  const verificar = async () => {
    if (sup === 'ios-nao-instalado') return setEstado('ios');
    if (sup !== 'ok') return setEstado('nao-suportado');
    if (Notification.permission === 'denied') return setEstado('bloqueado');
    if (inscricao) {
      for (const [k, c] of caixas) c.checked = inscricao.eventos.includes(k);
      // confirma que a assinatura ainda existe no navegador
      try {
        const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
        const sub = await reg?.pushManager.getSubscription();
        if (sub && sub.endpoint === inscricao.endpoint && Notification.permission === 'granted') return setEstado('ativo');
      } catch {
        /* segue como inativo */
      }
      inscricao = null;
      guardarInscricao(null);
    }
    setEstado('inativo');
  };

  const carregarConfig = async () => {
    try {
      config = await lerConfig();
      if (config.telegram_bot) {
        telegram.href = `https://t.me/${encodeURIComponent(config.telegram_bot)}`;
        telegram.hidden = false;
      }
    } catch {
      config = null;
    }
  };

  const ativar = async () => {
    const eventos = escolhidos();
    if (!eventos.length) return setEstado(estado, 'Escolha ao menos um tipo de aviso.');
    setEstado('processando');
    try {
      if (!config) await carregarConfig();
      if (!config?.vapid_publica) throw new Error('config');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return setEstado(perm === 'denied' ? 'bloqueado' : 'inativo', perm === 'denied' ? undefined : 'Permissão não concedida.');
      const reg = await registrarSW();
      await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlParaBytes(config.vapid_publica) as BufferSource });
      const r = await chamar<{ id: string }>('/inscrever', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), eventos }),
      });
      inscricao = { id: r.id, endpoint: sub.endpoint, eventos };
      guardarInscricao(inscricao);
      setEstado('ativo', `Alertas ativados: ${eventos.map((e) => EVENTOS.find((x) => x.chave === e)?.rotulo.toLowerCase() ?? e).join(', ')}.`);
    } catch (e) {
      console.warn('alertas: falha ao ativar', e);
      const nome = (e as { name?: string })?.name;
      setEstado('erro', nome === 'NotAllowedError' ? 'O navegador não permitiu a assinatura.' : 'Não foi possível ativar agora. Tente de novo em instantes.');
    }
  };

  const desativar = async () => {
    setEstado('processando');
    try {
      const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
      const sub = await reg?.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? inscricao?.endpoint;
      if (endpoint) await chamar('/inscrever', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint }) }).catch(() => undefined);
      await sub?.unsubscribe().catch(() => undefined);
    } finally {
      inscricao = null;
      guardarInscricao(null);
      for (const [k, c] of caixas) c.checked = PADRAO.includes(k);
      setEstado('inativo', 'Alertas desativados.');
    }
  };

  btnPrincipal.addEventListener('click', () => void ativar());
  btnDesativar.addEventListener('click', () => void desativar());

  // ---------------------------------------------------------------- abrir/fechar
  const abrir = (v: boolean) => {
    aberto = v;
    pop.hidden = !v;
    btn.setAttribute('aria-expanded', String(v));
    posicionar();
    if (v) {
      void verificar();
      if (!config) void carregarConfig();
      (pop.querySelector<HTMLElement>('input:not(:disabled), button:not([hidden])') ?? btnFechar).focus({ preventScroll: true });
    }
  };
  btn.addEventListener('click', () => abrir(!aberto));
  btnFechar.addEventListener('click', () => {
    abrir(false);
    btn.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && aberto) {
      abrir(false);
      btn.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (aberto && !slot.contains(e.target as Node) && !pop.contains(e.target as Node)) abrir(false);
  });

  setEstado('carregando');
  void verificar();
}

// ------------------------------------------------------------------ ícones
function svg(viewBox: string, d: string, fill = false): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('width', '18');
  s.setAttribute('height', '18');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  if (fill) p.setAttribute('fill', 'currentColor');
  else {
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
  }
  s.append(p);
  return s;
}
const iconeSino = () => svg('0 0 20 20', 'M10 2.5a4.5 4.5 0 0 0-4.5 4.5v2.6c0 .9-.3 1.7-.8 2.4L3.5 14h13l-1.2-2a4.3 4.3 0 0 1-.8-2.4V7A4.5 4.5 0 0 0 10 2.5zM8 16.5a2 2 0 0 0 4 0');
const iconeTelegram = () => svg('0 0 20 20', 'M17.4 3.2 2.9 8.9c-.9.4-.9 1 0 1.3l3.6 1.1 1.4 4.3c.2.5.3.7.8.7.4 0 .6-.2.8-.4l1.9-1.8 3.7 2.7c.7.4 1.2.2 1.4-.6L18.9 4.4c.3-1-.4-1.5-1.5-1.2zM8 11.5 14.5 7l-5.4 5.3-.3 2.6L8 11.5z', true);
const iconeX = () => svg('0 0 16 16', 'M3 3l10 10M13 3L3 13');
