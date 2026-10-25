// Atalhos de navegação no celular: a página é longa (placar, mapa, município, estados, totais,
// evolução); uma fileira de pílulas logo abaixo do placar leva direto a cada bloco.
import { el } from '../format';

const ALVOS: Array<[string, string]> = [
  ['#mapa', 'Mapa'],
  ['#meu-municipio', 'Meu município'],
  ['#caminho', 'Caminho'],
  ['#tabela', 'Por estado'],
  ['#totais', 'Totais'],
  ['#linha', 'Evolução'],
];

export function montarAtalhos(raiz: HTMLElement): void {
  const nav = el('nav', { class: 'atalhos', 'aria-label': 'Ir para' });
  for (const [href, rotulo] of ALVOS) {
    const a = el('a', { href, text: rotulo });
    a.addEventListener('click', (e) => {
      const alvo = document.querySelector<HTMLElement>(href);
      if (!alvo || alvo.hidden) return;
      e.preventDefault();
      alvo.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(history.state, '', href);
    });
    nav.append(a);
  }
  raiz.append(nav);
}
