// Plano de governo registrado no TSE: link para o PDF oficial, sumário do próprio documento e
// busca no texto. Nada é resumido nem comentado: o sumário só lista títulos que estão no PDF e
// a busca mostra trechos literais, cada um com a página onde está.

import { el } from '../format';
import { carregarPlano, urlDados, type Plano, type PlanoResumo } from './dados';

const SUMARIO_INICIAL = 12;
const PAGINAS_POR_VEZ = 8;
const TRECHOS_POR_PAGINA = 2;
const MARGEM = 90; // caracteres de contexto de cada lado
const PALAVRA_INTEIRA_ATE = 4; // "SUS" não acha "sustentável"; "imposto" acha "impostos"
const SUMARIO_INICIAL_FOLGA = 4; // não esconde só 2 ou 3 títulos atrás de um botão

const fmtMb = (b: number) => `${(b / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;
const fora = (href: string, ...filhos: (Node | string)[]) => el('a', { href, target: '_blank', rel: 'noopener' }, ...filhos);

/** "Saúde" -> "saude" com o mesmo comprimento, para os índices achados valerem no texto original. */
function dobrar(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i].normalize('NFD')[0].toLowerCase()[0];
    out += /\s/.test(c) ? ' ' : c;
  }
  return out;
}

interface Achado {
  doc: number;
  pagina: number; // 1..n
  posicoes: number[];
}

const letra = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);

/** Ocorrências que começam no início de uma palavra; termo curto (sigla) só como palavra inteira. */
function procurar(dobrados: string[][], q: string): { achados: Achado[]; ocorrencias: number } {
  const achados: Achado[] = [];
  let ocorrencias = 0;
  const inicio = letra(q[0]);
  const fim = q.length <= PALAVRA_INTEIRA_ATE && letra(q[q.length - 1]);
  dobrados.forEach((paginas, doc) =>
    paginas.forEach((texto, i) => {
      const posicoes: number[] = [];
      for (let p = texto.indexOf(q); p !== -1; p = texto.indexOf(q, p + 1)) {
        if (inicio && letra(texto[p - 1])) continue;
        if (fim && letra(texto[p + q.length])) continue;
        if (posicoes.length && p < posicoes[posicoes.length - 1] + q.length) continue;
        posicoes.push(p);
      }
      if (posicoes.length) {
        achados.push({ doc, pagina: i + 1, posicoes });
        ocorrencias += posicoes.length;
      }
    }),
  );
  return { achados, ocorrencias };
}

function trecho(texto: string, ini: number, n: number): HTMLElement {
  let a = Math.max(0, ini - MARGEM);
  let b = Math.min(texto.length, ini + n + MARGEM);
  // corta em espaço para não começar nem terminar no meio de uma palavra
  if (a > 0) {
    const sp = texto.indexOf(' ', a);
    if (sp !== -1 && sp < ini) a = sp + 1;
  }
  if (b < texto.length) {
    const sp = texto.lastIndexOf(' ', b);
    if (sp > ini + n) b = sp;
  }
  return el(
    'p',
    { class: 'plano-trecho' },
    a > 0 ? '…' : '',
    texto.slice(a, ini),
    el('mark', {}, texto.slice(ini, ini + n)),
    texto.slice(ini + n, b),
    b < texto.length ? '…' : '',
  );
}

const linkPagina = (plano: Plano, doc: number, pagina: number) => `${urlDados(plano.documentos[doc].pdf)}#page=${pagina}`;

function sumario(plano: Plano): HTMLElement {
  const partes = plano.documentos.length > 1;
  const itens: HTMLElement[] = [];
  plano.documentos.forEach((d, doc) => {
    for (const t of d.titulos) {
      itens.push(
        el(
          'li',
          {},
          fora(
            linkPagina(plano, doc, t.p),
            el('span', { class: 'plano-titulo' }, t.t),
            el('span', { class: 'plano-pag' }, partes ? `parte ${doc + 1}, p. ${t.p}` : `p. ${t.p}`),
          ),
        ),
      );
    }
  });
  if (!itens.length) {
    return el(
      'p',
      {},
      'O documento não tem sumário nem títulos que dê para reconhecer automaticamente. Use a busca abaixo ou abra o PDF.',
    );
  }
  const lista = el('ol', { class: 'plano-sumario' }, ...itens);
  if (itens.length <= SUMARIO_INICIAL + SUMARIO_INICIAL_FOLGA) return lista;

  itens.slice(SUMARIO_INICIAL).forEach((li) => (li.hidden = true));
  const botao = el('button', { type: 'button', class: 'btn-link', 'aria-expanded': 'false' }, `Mostrar os ${itens.length} títulos`);
  botao.addEventListener('click', () => {
    const abrir = botao.getAttribute('aria-expanded') !== 'true';
    itens.slice(SUMARIO_INICIAL).forEach((li) => (li.hidden = !abrir));
    botao.setAttribute('aria-expanded', String(abrir));
    botao.textContent = abrir ? 'Mostrar menos' : `Mostrar os ${itens.length} títulos`;
  });
  return el('div', {}, lista, el('p', { class: 'mais' }, botao));
}

function busca(plano: Plano): HTMLElement {
  const dobrados = plano.documentos.map((d) => d.paginas.map(dobrar));
  const campo = el('input', {
    type: 'search',
    id: 'plano-q',
    class: 'visor-input plano-campo',
    placeholder: 'Ex.: SUS, imposto, creche',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const resultado = el('div', { class: 'plano-resultado', 'aria-live': 'polite' });
  const partes = plano.documentos.length > 1;

  const render = () => {
    const bruto = campo.value.trim().replace(/\s+/g, ' ');
    const q = dobrar(bruto);
    if (q.length < 2) {
      resultado.replaceChildren();
      return;
    }
    const { achados, ocorrencias } = procurar(dobrados, q);
    if (!achados.length) {
      resultado.replaceChildren(el('p', { class: 'plano-contagem' }, `Nenhuma ocorrência de “${bruto}” no plano.`));
      return;
    }
    const lista = el('ol', { class: 'plano-achados' });
    let mostrados = 0;
    const mais = el('button', { type: 'button', class: 'btn-link' });
    const maisBox = el('p', { class: 'mais' }, mais);
    const proximas = () => {
      for (const a of achados.slice(mostrados, mostrados + PAGINAS_POR_VEZ)) {
        const texto = plano.documentos[a.doc].paginas[a.pagina - 1];
        // trechos que não se sobrepõem
        const usadas: number[] = [];
        for (const p of a.posicoes) {
          if (usadas.length >= TRECHOS_POR_PAGINA) break;
          if (usadas.length && p - usadas[usadas.length - 1] < MARGEM * 2) continue;
          usadas.push(p);
        }
        const extra = a.posicoes.length - usadas.length;
        lista.append(
          el(
            'li',
            {},
            el('p', { class: 'plano-achado-pag' }, fora(linkPagina(plano, a.doc, a.pagina), partes ? `Parte ${a.doc + 1}, página ${a.pagina}` : `Página ${a.pagina}`)),
            ...usadas.map((p) => trecho(texto, p, bruto.length)),
            extra > 0 ? el('p', { class: 'nota' }, `e mais ${plural(extra, 'vez', 'vezes')} nesta página`) : null,
          ),
        );
      }
      mostrados = Math.min(achados.length, mostrados + PAGINAS_POR_VEZ);
      const resta = achados.length - mostrados;
      maisBox.hidden = resta <= 0;
      mais.textContent = `Mostrar mais ${plural(Math.min(resta, PAGINAS_POR_VEZ), 'página', 'páginas')}`;
    };
    mais.addEventListener('click', proximas);
    proximas();
    resultado.replaceChildren(
      el(
        'p',
        { class: 'plano-contagem' },
        `“${bruto}” aparece ${plural(ocorrencias, 'vez', 'vezes')}, em ${plural(achados.length, 'página', 'páginas')}.`,
      ),
      lista,
      maisBox,
    );
  };

  let espera = 0;
  campo.addEventListener('input', () => {
    clearTimeout(espera);
    espera = window.setTimeout(render, 180);
  });
  const form = el(
    'form',
    { role: 'search', class: 'plano-busca' },
    el('label', { for: 'plano-q', class: 'plano-rotulo' }, 'Palavra ou expressão'),
    campo,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    clearTimeout(espera);
    render();
  });
  return el('div', {}, form, resultado);
}

/** Corpo da seção "Plano de governo"; o texto (100–300 KB) só é baixado quando a ficha abre. */
export function montarPlano(r: PlanoResumo, nome: string): HTMLElement[] {
  const corpo = el('div', { class: 'plano-corpo' }, el('p', { class: 'carregando' }, 'Carregando o sumário…'));
  carregarPlano(r)
    .then((plano) => {
      corpo.replaceChildren(
        el('h3', {}, 'Sumário'),
        sumario(plano),
        el('h3', {}, 'Procurar no plano'),
        busca(plano),
        el(
          'p',
          { class: 'nota' },
          'O texto foi extraído automaticamente do PDF: tabelas, colunas e imagens podem sair fora de ordem ou faltar. Na dúvida, vale o PDF.',
        ),
      );
    })
    .catch(() => {
      corpo.replaceChildren(el('p', {}, 'Não foi possível carregar o sumário e a busca. O PDF continua disponível no link acima.'));
    });
  return [
    el(
      'p',
      {},
      `Documento que ${nome} registrou no TSE com o pedido de candidatura. Abaixo estão os títulos do próprio documento e uma busca no texto. O site não resume nem comenta o plano.`,
    ),
    el(
      'p',
      { class: 'plano-pdf' },
      fora(urlDados(r.pdf), 'Abrir o PDF oficial'),
      el('span', { class: 'nota' }, ` ${plural(r.paginas, 'página', 'páginas')}, ${fmtMb(r.bytes)}`),
    ),
    corpo,
  ];
}
