// Placar compacto preso ao topo no celular: aparece quando o placar grande sai da tela, para a
// pessoa acompanhar o resultado enquanto rola o mapa, a tabela ou conversa no chat ancorado.
import { textoSobre } from '../color';
import { el, fmtPct, iniciais } from '../format';
import type { Store } from '../store';

const ESTREITO = '(max-width: 1099px)';

export function montarMiniPlacar(raiz: HTMLElement, store: Store, hero: HTMLElement): void {
  const swA = el('i', { class: 'mp-sw', 'aria-hidden': 'true' });
  const swB = el('i', { class: 'mp-sw', 'aria-hidden': 'true' });
  const nomeA = el('b');
  const nomeB = el('b');
  const pctA = el('span', { class: 'num' });
  const pctB = el('span', { class: 'num' });
  const barA = el('i');
  const barB = el('i');
  const secoes = el('span', { class: 'mp-sec num' });
  const btn = el(
    'button',
    { class: 'mini-placar', type: 'button', hidden: true, 'aria-label': 'Voltar ao placar completo' },
    el('span', { class: 'mp-side' }, swA, nomeA, pctA),
    el('span', { class: 'mp-bar', 'aria-hidden': 'true' }, barA, barB),
    el('span', { class: 'mp-side right' }, pctB, nomeB, swB),
    secoes,
  );
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  raiz.append(btn);

  const mq = matchMedia(ESTREITO);
  let heroVisivel = true;
  let temDados = false;
  const aplicar = () => {
    btn.hidden = !(mq.matches && !heroVisivel && temDados);
  };
  new IntersectionObserver(
    (entries) => {
      heroVisivel = entries[0]?.isIntersecting ?? true;
      aplicar();
    },
    { rootMargin: '-56px 0px 0px 0px', threshold: 0 },
  ).observe(hero);
  mq.addEventListener('change', aplicar);

  const render = () => {
    const br = store.br;
    if (!br || !store.meta || store.principais.length < 2) return;
    const [a, b] = store.principais;
    const corA = store.paleta.cores[a];
    const corB = store.paleta.cores[b];
    swA.style.background = corA;
    swB.style.background = corB;
    swA.style.color = textoSobre(corA);
    swB.style.color = textoSobre(corB);
    swA.textContent = iniciais(store.cand(a).nome);
    swB.textContent = iniciais(store.cand(b).nome);
    nomeA.textContent = primeiroNome(store.cand(a).nome);
    nomeB.textContent = primeiroNome(store.cand(b).nome);
    const pa = br.pct[a] ?? 0;
    const pb = br.pct[b] ?? 0;
    pctA.textContent = fmtPct(pa, 1);
    pctB.textContent = fmtPct(pb, 1);
    barA.style.width = `${pa}%`;
    barA.style.background = corA;
    barB.style.width = `${pb}%`;
    barB.style.background = corB;
    secoes.textContent = `${Math.round(br.secoes.pct)}% das seções`;
    temDados = true;
    aplicar();
  };
  store.on(['br', 'tema'], render);
  render();
}

function primeiroNome(nome: string): string {
  const p = nome.trim().split(/\s+/)[0] ?? nome;
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
