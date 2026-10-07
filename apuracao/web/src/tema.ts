// Tema claro / escuro / automático. A escolha fica em localStorage.tema e é aplicada
// antes da primeira pintura por um script inline no <head> (index.html); aqui ficam a
// leitura, a aplicação (atributo data-theme + <meta name="theme-color">) e o controle
// de 3 estados da barra superior.

import { el, svgEl } from './format';
import type { Store } from './store';

export type Tema = 'auto' | 'light' | 'dark';

export const CHAVE_TEMA = 'tema';
const CORES = { light: '#f6f5f1', dark: '#111113' } as const;
const ORDEM: Tema[] = ['auto', 'light', 'dark'];
const ROTULO: Record<Tema, string> = { auto: 'Automático', light: 'Claro', dark: 'Escuro' };
const CURTO: Record<Tema, string> = { auto: 'Auto', light: 'Claro', dark: 'Escuro' };

export function lerTema(): Tema {
  try {
    const v = localStorage.getItem(CHAVE_TEMA);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Aplica o atributo em <html> e ajusta a cor da barra do navegador. Não persiste. */
export function aplicarTema(t: Tema): void {
  const html = document.documentElement;
  if (t === 'auto') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', t);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = m.getAttribute('media') ?? '';
    const padrao = media.includes('dark') ? CORES.dark : CORES.light;
    m.setAttribute('content', t === 'auto' ? padrao : CORES[t]);
  }
}

export function guardarTema(t: Tema): void {
  try {
    if (t === 'auto') localStorage.removeItem(CHAVE_TEMA);
    else localStorage.setItem(CHAVE_TEMA, t);
  } catch {
    /* sem armazenamento */
  }
}

/**
 * Botão compacto que alterna auto → claro → escuro. Chama `store.atualizarTema()`
 * para o mapa e a paleta re-renderizarem.
 */
export function montarToggleTema(store: Store): HTMLElement {
  let tema = lerTema();
  const icone = svgEl('svg', { viewBox: '0 0 20 20', width: 18, height: 18, 'aria-hidden': 'true', class: 'tema-ico' });
  const rotulo = el('span', { class: 'tema-lbl' });
  const btn = el('button', { class: 'btn tema-toggle', type: 'button', 'data-tema': tema }, icone, rotulo);

  const render = () => {
    btn.dataset.tema = tema;
    rotulo.textContent = CURTO[tema];
    const prox = ORDEM[(ORDEM.indexOf(tema) + 1) % ORDEM.length];
    const titulo = `Tema: ${ROTULO[tema].toLowerCase()} · clique para ${ROTULO[prox].toLowerCase()}`;
    btn.title = titulo;
    btn.setAttribute('aria-label', titulo);
    icone.replaceChildren(...desenho(tema));
  };

  btn.addEventListener('click', () => {
    tema = ORDEM[(ORDEM.indexOf(tema) + 1) % ORDEM.length];
    guardarTema(tema);
    // com o telão aberto o escuro é forçado; ele restaura a escolha ao sair
    if (!document.documentElement.classList.contains('telao-aberto')) {
      aplicarTema(tema);
      store.atualizarTema();
    }
    render();
  });
  render();
  return btn;
}

function desenho(t: Tema): SVGElement[] {
  const traco = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (t === 'light') {
    const raios = svgEl('path', { ...traco, d: 'M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4' });
    return [svgEl('circle', { ...traco, cx: 10, cy: 10, r: 3.6 }), raios];
  }
  if (t === 'dark') return [svgEl('path', { ...traco, d: 'M15.5 12.2A6.3 6.3 0 0 1 7.8 4.5a6.3 6.3 0 1 0 7.7 7.7z' })];
  // automático: meio sol, meio lua (círculo dividido)
  return [
    svgEl('circle', { ...traco, cx: 10, cy: 10, r: 6.5 }),
    svgEl('path', { d: 'M10 3.5a6.5 6.5 0 0 1 0 13z', fill: 'currentColor' }),
  ];
}
