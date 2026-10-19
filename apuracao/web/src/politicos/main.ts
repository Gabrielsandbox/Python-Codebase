// Página pública "Depois do voto": busca (?q=&cargo=&uf=) e ficha (?p=<id>), sem framework.

import '../politicos.css';
import { el } from '../format';
import { guardarTema, lerTema, type Tema } from '../tema';
import { montarBusca, type Busca } from './busca';
import { carregarFicha, carregarIndice, ErroDados } from './dados';
import { montarFicha } from './ficha';
import { fmtDia } from './ui';

const main = document.getElementById('conteudo') as HTMLElement;
let busca: Busca | null = null;
let fichaAberta: string | null = null;

async function rota(): Promise<void> {
  const id = new URL(location.href).searchParams.get('p');
  // o índice da ficha (#presenca, #gastos…) também dispara popstate: a ficha é a mesma, o navegador já rolou
  if (id && id === fichaAberta) return;
  fichaAberta = null;
  main.setAttribute('aria-busy', 'true');
  if (!id) {
    busca ??= montarBusca();
    main.replaceChildren(busca.raiz);
    document.title = 'Depois do voto — Apuração ao Vivo';
    main.setAttribute('aria-busy', 'false');
    return;
  }
  main.replaceChildren(el('p', { class: 'carregando' }, 'Abrindo a ficha…'));
  try {
    const ficha = await carregarFicha(id);
    main.replaceChildren(montarFicha(ficha));
    fichaAberta = id;
    document.title = `${ficha.nome} — Depois do voto`;
    main.querySelector<HTMLElement>('.ficha-nome')?.focus({ preventScroll: true });
    // link compartilhado com #seção: a ficha chegou depois do carregamento, então a rolagem é nossa
    const secao = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    if (secao) secao.scrollIntoView();
    else window.scrollTo({ top: 0 });
  } catch (e) {
    const naoExiste = e instanceof ErroDados && e.status === 404;
    main.replaceChildren(
      el(
        'div',
        { class: 'aviso aviso--erro' },
        el('p', {}, naoExiste ? 'Não existe ficha com esse endereço. Ela pode ter mudado na última atualização.' : 'Não foi possível abrir a ficha. Verifique a conexão e tente de novo.'),
        el('p', {}, el('a', { href: '?', 'data-voltar': '' }, 'Voltar para a busca')),
      ),
    );
  }
  main.setAttribute('aria-busy', 'false');
}

// links internos (?p=…, ?) sem recarregar a página; a busca guarda a posição de rolagem
let rolagemBusca = 0;
document.addEventListener('click', (ev) => {
  const a = (ev.target as Element).closest<HTMLAnchorElement>('a[href^="?"]');
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
  ev.preventDefault();
  if (a.hasAttribute('data-voltar') && history.state?.daBusca) {
    history.back();
    return;
  }
  if (!new URL(location.href).searchParams.get('p')) rolagemBusca = window.scrollY;
  history.pushState({ daBusca: !new URL(location.href).searchParams.get('p') }, '', a.href);
  void rota();
});
window.addEventListener('popstate', () => {
  void rota().then(() => {
    if (!new URL(location.href).searchParams.get('p')) window.scrollTo({ top: rolagemBusca });
  });
});

// ------------------------------------------------------------------ tema (mesma chave do site)

const COR_TEMA = { light: '#e4e9e2', dark: '#121614' } as const;
const ORDEM: Tema[] = ['auto', 'light', 'dark'];
const ROTULO: Record<Tema, string> = { auto: 'Tema automático', light: 'Tema claro', dark: 'Tema escuro' };

function aplicar(t: Tema): void {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const padrao = (m.getAttribute('media') ?? '').includes('dark') ? COR_TEMA.dark : COR_TEMA.light;
    m.setAttribute('content', t === 'auto' ? padrao : COR_TEMA[t]);
  }
}

function montarTema(): HTMLElement {
  let t = lerTema();
  const b = el('button', { type: 'button', class: 'pol-tema' });
  const render = () => {
    b.textContent = { auto: 'Auto', light: 'Claro', dark: 'Escuro' }[t];
    b.setAttribute('aria-label', `${ROTULO[t]}. Trocar tema`);
  };
  b.addEventListener('click', () => {
    t = ORDEM[(ORDEM.indexOf(t) + 1) % ORDEM.length];
    guardarTema(t);
    aplicar(t);
    render();
  });
  render();
  return b;
}

document.getElementById('tema-slot')?.replaceWith(montarTema());
carregarIndice()
  .then((i) => {
    const r = document.getElementById('rodape-atualizado');
    if (r) r.textContent = `Última atualização: ${fmtDia(i.gerado_em)}.`;
  })
  .catch(() => {});
void rota();
