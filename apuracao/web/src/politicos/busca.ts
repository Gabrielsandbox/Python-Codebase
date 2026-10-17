// Tela de busca: o "visor" da urna (os dígitos digitados preenchem as casas) + resultados.

import { el } from '../format';
import { buscar, carregarIndice, type Filtros, type Indice, type ItemIndice } from './dados';
import { avatar, CASAS, cargoComUf, rotuloMandato, SITUACAO, UFS, urnaNumero } from './ui';

const CARGOS_FILTRO: [string, string][] = [
  ['', 'Todos'],
  ['m', 'Com mandato no Congresso'],
  ['1', 'Presidente'],
  ['3', 'Governador'],
  ['5', 'Senador'],
  ['6', 'Deputado federal'],
  ['7', 'Deputado estadual'],
];
const CASAS_VISOR = 5;

export interface Busca {
  raiz: HTMLElement;
  focar(): void;
}

export function filtrosDaUrl(u = new URL(location.href)): Filtros {
  return { texto: u.searchParams.get('q') ?? '', cargo: u.searchParams.get('cargo') ?? '', uf: u.searchParams.get('uf') ?? '' };
}

function guardarNaUrl(f: Filtros): void {
  const u = new URL(location.href);
  for (const [k, v] of [['q', f.texto], ['cargo', f.cargo], ['uf', f.uf]] as const) {
    if (v) u.searchParams.set(k, v);
    else u.searchParams.delete(k);
  }
  u.searchParams.delete('p');
  history.replaceState(history.state, '', u);
}

export function montarBusca(): Busca {
  const f = filtrosDaUrl();

  const casas = el('div', { class: 'visor-casas', 'aria-hidden': 'true' });
  const input = el('input', {
    id: 'q',
    class: 'visor-input',
    type: 'search',
    inputmode: 'search',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Nome ou número, como Tabata ou 1310',
    'aria-describedby': 'visor-dica',
    'aria-controls': 'resultados',
  });
  input.value = f.texto;

  const cargo = el('div', { class: 'filtro-cargos', role: 'radiogroup', 'aria-label': 'Cargo' });
  for (const [valor, rotulo] of CARGOS_FILTRO) {
    const id = `cargo-${valor || 'todos'}`;
    const r = el('input', { type: 'radio', name: 'cargo', id, value: valor, class: 'filtro-radio' });
    r.checked = valor === f.cargo;
    cargo.append(r, el('label', { for: id, class: 'filtro-chip' }, rotulo));
  }

  const uf = el('select', { id: 'uf', class: 'filtro-uf' });
  uf.append(el('option', { value: '' }, 'Todo o Brasil'));
  for (const [sigla, nome] of Object.entries(UFS)) uf.append(el('option', { value: sigla }, nome));
  uf.value = f.uf;

  const contagem = el('p', { class: 'busca-contagem', id: 'busca-contagem', 'aria-live': 'polite' });
  const lista = el('ol', { class: 'resultados', id: 'resultados' });
  const mais = el('p', { class: 'busca-mais' });

  const raiz = el(
    'section',
    { class: 'busca', 'aria-labelledby': 'busca-titulo' },
    el('h1', { class: 'busca-titulo', id: 'busca-titulo' }, 'Depois do voto'),
    el(
      'p',
      { class: 'busca-lede' },
      'Procure qualquer candidato de 2026 pelo nome ou pelo número de urna. De quem tem mandato no Congresso, mostramos presença, votos, propostas e gastos, direto da Câmara, do Senado e do TSE.',
    ),
    el(
      'div',
      { class: 'visor' },
      el('label', { for: 'q', class: 'visor-rotulo' }, 'Quem você quer conferir?'),
      casas,
      input,
      el('p', { class: 'visor-dica', id: 'visor-dica' }, 'Digite o número que você apertou na urna e o nome aparece embaixo.'),
      el('div', { class: 'visor-filtros' }, cargo, el('label', { class: 'sr-only', for: 'uf' }, 'Estado'), uf),
    ),
    contagem,
    lista,
    mais,
  );

  let indice: Indice | null = null;

  const desenharCasas = () => {
    const d = input.value.replace(/\D/g, '');
    const so = /^\s*\d*\s*$/.test(input.value);
    casas.classList.toggle('visor-casas--texto', !so && input.value.trim() !== '');
    casas.replaceChildren(urnaNumero(so ? d.slice(0, CASAS_VISOR) : '', CASAS_VISOR, 'g'));
  };

  const linha = (it: ItemIndice, cargos: Record<string, string>): HTMLElement => {
    const cargoNome = it.cargo ? cargos[it.cargo] : it.mandato === 'd' ? 'Deputado federal' : 'Senador';
    const meta = [cargoComUf(it.cargo ? `Candidato a ${cargoNome.toLowerCase()}` : `${cargoNome}, não concorreu`, it.uf), it.partido]
      .filter(Boolean)
      .join(', ');
    const tag = rotuloMandato(it);
    return el(
      'li',
      {},
      el(
        'a',
        { class: 'res', href: `?p=${it.id}`, 'data-id': it.id },
        avatar(it.nome, null, 'avatar avatar--p'),
        el(
          'span',
          { class: 'res-txt' },
          el('span', { class: 'res-nome' }, it.nome),
          el('span', { class: 'res-meta' }, meta),
          el(
            'span',
            { class: 'res-tags' },
            it.cargo ? el('span', { class: `sit sit--${it.situacao || 'sem'}` }, SITUACAO[it.situacao]) : null,
            tag ? el('span', { class: 'tag-mandato' }, tag) : null,
          ),
        ),
        it.numero ? urnaNumero(it.numero, CASAS[it.cargo] ?? it.numero.length, 'p') : el('span'),
      ),
    );
  };

  const render = () => {
    desenharCasas();
    if (!indice) return;
    const filtros: Filtros = {
      texto: input.value,
      cargo: (cargo.querySelector<HTMLInputElement>('input:checked')?.value ?? ''),
      uf: uf.value,
    };
    guardarNaUrl(filtros);
    const vazio = !filtros.texto.trim() && !filtros.cargo && !filtros.uf;
    if (vazio) {
      // sem busca: quem ainda está na disputa é o que mais gente procura nesta semana
      const disputa = indice.itens.filter((i) => i.situacao === '2turno');
      contagem.textContent = 'Na disputa do 2º turno, em 25 de outubro';
      lista.replaceChildren(...disputa.map((i) => linha(i, indice!.cargos)));
      mais.textContent = 'Ou procure pelo nome, pelo número ou escolha um estado.';
      return;
    }
    const { lista: achados, total } = buscar(indice.itens, filtros);
    if (!total) {
      contagem.textContent = /^\s*\d+\s*$/.test(filtros.texto)
        ? `Nenhum candidato com o número ${filtros.texto.trim()} nesse filtro. Confira o estado: o mesmo número existe em cada UF.`
        : 'Ninguém com esse nome nesse filtro. Tente só o sobrenome, ou o nome que aparecia na urna.';
      lista.replaceChildren();
      mais.textContent = '';
      return;
    }
    contagem.textContent = total === 1 ? '1 resultado' : `${total.toLocaleString('pt-BR')} resultados`;
    lista.replaceChildren(...achados.map((i) => linha(i, indice!.cargos)));
    mais.textContent = total > achados.length ? `Mostrando os ${achados.length} mais próximos. Escreva mais do nome ou escolha um estado para afinar.` : '';
  };

  let espera = 0;
  input.addEventListener('input', () => {
    desenharCasas();
    clearTimeout(espera);
    espera = window.setTimeout(render, 90);
  });
  cargo.addEventListener('change', render);
  uf.addEventListener('change', render);

  desenharCasas();
  contagem.textContent = 'Carregando a lista de candidatos…';
  carregarIndice()
    .then((i) => {
      indice = i;
      render();
    })
    .catch(() => {
      contagem.textContent = 'Não foi possível carregar a lista de candidatos. Verifique a conexão e recarregue a página.';
    });

  return { raiz, focar: () => input.focus({ preventScroll: true }) };
}
