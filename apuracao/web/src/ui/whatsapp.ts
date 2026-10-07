// Botão "Compartilhar no WhatsApp": texto com o placar nacional (store.principais) e a URL
// da página sem hash, sempre via https://wa.me/?text= em nova aba. No celular, quando
// `navigator.share` existe, um link secundário "outros apps" abre a folha nativa.

import { el, fmtPct, nomeProprio, pulsar, svgEl } from '../format';
import type { Store } from '../store';

export const urlPagina = (): string => `${location.origin}${location.pathname}${location.search}`;

/** "Apuração 2026 · 2º turno: A 51,2% × B 48,8% (71,0% das seções) — acompanhe ao vivo: {url}" */
export function textoCompartilharBr(store: Store): string | null {
  const br = store.br;
  const m = store.meta;
  if (!br || !m || store.principais.length < 2) return null;
  const [a, b] = store.principais;
  const ano = m.data_eleicao.slice(0, 4);
  const na = nomeProprio(store.cand(a).nome);
  const nb = nomeProprio(store.cand(b).nome);
  return `Apuração ${ano} · ${m.turno}º turno: ${na} ${fmtPct(br.pct[a] ?? 0, 1)} × ${nb} ${fmtPct(br.pct[b] ?? 0, 1)} (${fmtPct(br.secoes.pct, 1)} das seções) — acompanhe ao vivo: ${urlPagina()}`;
}

export const abrirWhatsApp = (texto: string): void => {
  window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
};

/** Glifo do WhatsApp (SVG inline, sem arquivos externos). */
export function iconeWhatsApp(tam = 20): SVGSVGElement {
  const s = svgEl('svg', { viewBox: '0 0 24 24', width: tam, height: tam, 'aria-hidden': 'true', class: 'wa-ico' });
  s.append(
    svgEl('path', {
      fill: 'currentColor',
      d: 'M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.26 8.26 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24 4.54 0 8.24 3.7 8.24 8.24.01 4.54-3.69 8.24-8.23 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z',
    }),
  );
  return s;
}

export interface BotaoWhatsAppOpts {
  /** Só o ícone com rótulo curto (barra superior). */
  compacto?: boolean;
  /** Mostra o link "outros apps" (navigator.share) quando disponível. */
  outrosApps?: boolean;
  /** Texto a compartilhar; por padrão, o placar nacional. */
  texto?: () => string | null;
  /** Pulsa quando `br` muda. */
  pulsar?: boolean;
}

/** Monta o botão (e, opcionalmente, o link "outros apps") num contêiner `.wa-share`. */
export function montarBotaoWhatsApp(store: Store, opts: BotaoWhatsAppOpts = {}): HTMLElement {
  const texto = opts.texto ?? (() => textoCompartilharBr(store));
  const btn = el(
    'button',
    { class: `btn-wa${opts.compacto ? ' compacto' : ''}`, type: 'button', title: 'Compartilhar o placar no WhatsApp' },
    iconeWhatsApp(opts.compacto ? 18 : 20),
    el('span', { class: 'wa-txt', text: 'Compartilhar no WhatsApp' }),
  );
  btn.setAttribute('aria-label', 'Compartilhar no WhatsApp');
  btn.addEventListener('click', () => {
    const t = texto();
    if (t) abrirWhatsApp(t);
  });
  const wrap = el('div', { class: `wa-share${opts.compacto ? ' compacto' : ''}` }, btn);

  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  if (opts.outrosApps && typeof nav.share === 'function') {
    const outros = el('button', { class: 'wa-outros', type: 'button', text: 'outros apps' });
    outros.addEventListener('click', async () => {
      const t = texto();
      if (!t) return;
      try {
        await nav.share!({ text: t, title: 'Apuração 2026' });
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') abrirWhatsApp(t);
      }
    });
    wrap.append(el('span', { class: 'wa-ou', text: 'ou' }), outros);
  }

  // pulsa só quando o placar MUDA (o Poller emite `br` apenas com conteúdo novo), não na 1ª carga
  let jaTinha = !!texto();
  const atualizar = () => {
    const ok = !!texto();
    btn.disabled = !ok;
    if (ok && jaTinha && opts.pulsar) pulsar(btn, 'wa-pulse');
    jaTinha = ok;
  };
  store.on('br', atualizar);
  btn.disabled = !jaTinha;
  return wrap;
}
