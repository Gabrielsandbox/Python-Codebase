// "Confira na fonte": links discretos para o JSON oficial do TSE (docs/RECURSOS.md §4).
// Quando o snapshot não traz `fonte` (dados antigos), os links ficam ocultos.

import { el } from '../format';
import type { Store } from '../store';

function preencher(template: string | undefined, vars: Record<string, string>): string | null {
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

export function urlFonteBr(store: Store): string | null {
  return store.br?.fonte ?? store.meta?.fonte?.br ?? null;
}

export function urlFonteUf(store: Store, sigla: string): string | null {
  return store.uf?.ufs[sigla]?.fonte ?? preencher(store.meta?.fonte?.uf, { uf: sigla.toLowerCase() });
}

export function urlFonteMun(store: Store, ibge: string): string | null {
  const ref = store.refMun?.[ibge];
  if (!ref) return null;
  return preencher(store.meta?.fonte?.municipio, { uf: ref.uf.toLowerCase(), tse: ref.tse });
}

/**
 * Âncora "fonte: TSE ↗" (ou só o ícone). Fica `hidden` sem URL; use `atualizarFonte` para
 * trocar o destino quando os dados mudarem.
 */
export function linkFonte(url: string | null, opts: { icone?: boolean; rotulo?: string } = {}): HTMLAnchorElement {
  const a = el('a', {
    class: opts.icone ? 'fonte-ic' : 'fonte-link',
    target: '_blank',
    rel: 'noopener',
    title: 'Abrir o arquivo oficial do TSE (JSON) em uma nova aba',
    'aria-label': opts.icone ? 'Conferir na fonte: arquivo oficial do TSE' : undefined,
  });
  if (opts.icone) a.textContent = '↗';
  else a.append(el('span', { text: opts.rotulo ?? 'fonte: TSE' }), el('span', { class: 'arr', 'aria-hidden': 'true', text: '↗' }));
  a.addEventListener('click', (e) => e.stopPropagation());
  atualizarFonte(a, url);
  return a;
}

export function atualizarFonte(a: HTMLAnchorElement, url: string | null): void {
  if (url) a.href = url;
  else a.removeAttribute('href');
  a.hidden = !url;
}
