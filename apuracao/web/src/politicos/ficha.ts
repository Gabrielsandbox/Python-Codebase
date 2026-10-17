// Ficha de um político: mandato no Congresso (presença, votos, propostas, gastos) + candidatura 2026.

import { el } from '../format';
import type { Candidatura, Despesas, Ficha, Mandato, PresencaCamara, PresencaSenado, Proposicao, Voto } from './dados';
import { montarPlano } from './plano';
import {
  avatar,
  CASAS,
  fmtDia,
  fmtMesAno,
  fmtPorcento,
  fmtReais,
  fmtReaisCurto,
  SITUACAO,
  UFS,
  urnaNumero,
} from './ui';

const VOTO: Record<string, string> = {
  Sim: 'Sim',
  Não: 'Não',
  Abstenção: 'Abstenção',
  Obstrução: 'Obstrução',
  'Artigo 17': 'Presidia a sessão',
  'Presidente (art. 51 RISF)': 'Presidia a sessão',
  Votou: 'Votou (voto secreto)',
  'P-NRV': 'Presente, não votou',
  NCom: 'Não compareceu',
  AP: 'Em atividade parlamentar',
  LS: 'Licença de saúde',
  MIS: 'Em missão oficial',
  LP: 'Licença particular',
  LAP: 'Licença',
  '': 'Sem voto registrado',
};
const TIPO: Record<string, string> = {
  PEC: 'Emendas à Constituição',
  PL: 'Projetos de lei',
  PLS: 'Projetos de lei',
  PLP: 'Leis complementares',
  PDL: 'Decretos legislativos',
  PRC: 'Resoluções',
  PRS: 'Resoluções',
};

const feminino = (f: Ficha) => f.candidatura?.genero === 'Feminino' || /^(Deputada|Senadora)/.test(f.mandato?.cargo ?? '');

function cargoGenero(cargo: string, fem: boolean): string {
  if (!fem) return cargo;
  // \b: o Senado já manda "Senadora"
  return cargo.replace(/^Deputado\b/, 'Deputada').replace(/^Governador\b/, 'Governadora').replace(/^Senador\b/, 'Senadora');
}

function secao(id: string, titulo: string, ...filhos: (Node | string | null | false)[]): HTMLElement {
  return el('section', { class: 'ficha-secao', id, 'aria-labelledby': `${id}-t` }, el('h2', { id: `${id}-t` }, titulo), ...filhos);
}

const nota = (txt: string) => el('p', { class: 'nota' }, txt);
const fora = (href: string, txt: string, classe = '') =>
  el('a', { href, target: '_blank', rel: 'noopener', class: classe || null }, txt);

// ------------------------------------------------------------------ presença

function regua(linha: string, anos: { ano: number; n: number }[]): HTMLElement {
  const box = el('div', { class: 'regua', 'aria-hidden': 'true' });
  let i = 0;
  for (const { ano, n } of anos) {
    const fatia = linha.slice(i, i + n);
    i += n;
    const marcas = el('span', { class: 'regua-marcas' });
    for (const c of fatia) marcas.append(el('span', { class: `marca marca--${c}` }));
    box.append(el('div', { class: 'regua-ano' }, el('span', { class: 'regua-rotulo' }, String(ano)), marcas));
  }
  return box;
}

function presenca(m: Mandato): HTMLElement {
  const p = m.presenca;
  if (!p) return secao('presenca', 'Presença', el('p', {}, 'Ainda não há registro de presença neste mandato.'));
  if (m.casa === 'camara') {
    const c = p as PresencaCamara;
    const taxa = c.presente / c.sessoes;
    return secao(
      'presenca',
      'Presença',
      el(
        'p',
        { class: 'presenca-frase' },
        el('strong', { class: 'presenca-taxa' }, fmtPorcento(taxa)),
        ` Esteve em ${c.presente} de ${c.sessoes} sessões deliberativas do plenário desde ${fmtMesAno(c.desde)}.`,
      ),
      regua(c.linha, c.por_ano.map((a) => ({ ano: a.ano, n: a.sessoes }))),
      el('p', { class: 'legenda' }, el('span', { class: 'marca marca--p' }), ' presente ', el('span', { class: 'marca marca--a' }), ' sem registro de presença'),
      nota('Cada quadrado é uma sessão em que houve votação no plenário, em ordem. A Câmara não publica nos dados abertos as faltas justificadas (licença médica, missão oficial), então elas aparecem aqui como sem registro.'),
    );
  }
  const s = p as PresencaSenado;
  const taxa = s.presente / s.votacoes;
  const partes = [
    s.justificada ? `${s.justificada} com justificativa (licença, missão ou outra atividade parlamentar)` : '',
    s.sem_justificativa ? `${s.sem_justificativa} sem justificativa` : '',
  ].filter(Boolean);
  return secao(
    'presenca',
    'Presença',
    el(
      'p',
      { class: 'presenca-frase' },
      el('strong', { class: 'presenca-taxa' }, fmtPorcento(taxa)),
      ` Participou de ${s.presente} das ${s.votacoes} votações nominais do Senado${s.desde ? ` desde ${fmtMesAno(s.desde)}` : ''}.`,
      partes.length ? ` Das ausências, ${partes.join(' e ')}.` : ' Não faltou a nenhuma.',
    ),
    regua(s.linha, s.por_ano.map((a) => ({ ano: a.ano, n: a.votacoes }))),
    el(
      'p',
      { class: 'legenda' },
      el('span', { class: 'marca marca--p' }), ' presente ',
      el('span', { class: 'marca marca--j' }), ' ausência justificada ',
      el('span', { class: 'marca marca--a' }), ' não compareceu',
    ),
    nota('Cada quadrado é uma votação nominal no plenário, em ordem. O Senado registra o motivo de cada ausência; usamos exatamente o que está lá.'),
  );
}

// ------------------------------------------------------------------ votos

function classeVoto(v: string): string {
  if (v === 'Sim') return 'voto--sim';
  if (v === 'Não') return 'voto--nao';
  if (v === 'NCom') return 'voto--ausente';
  return 'voto--outro';
}

function votos(m: Mandato): HTMLElement {
  const v = m.votos;
  if (!v.total) return secao('votos', 'Como votou', el('p', {}, 'Nenhuma votação nominal registrada no período.'));
  const resumo = el('dl', { class: 'contas' });
  for (const [voto, n] of Object.entries(v.por_voto)) {
    resumo.append(el('div', {}, el('dt', {}, VOTO[voto] ?? voto), el('dd', { class: 'num' }, String(n))));
  }
  // a mesma proposta costuma ter várias votações seguidas (turnos, destaques): a partir da
  // segunda, a descrição da votação diz mais que a ementa repetida
  const linhaVoto = (x: Voto, i: number, todos: Voto[]) =>
    el(
      'li',
      { class: 'votacao' },
      el('span', { class: 'votacao-data' }, fmtDia(x.data)),
      el(
        'div',
        { class: 'votacao-txt' },
        x.proposicao
          ? el('p', { class: 'votacao-prop' }, x.url ? fora(x.url, x.proposicao) : x.proposicao, x.aprovada ? ', aprovada' : ', rejeitada')
          : null,
        el('p', { class: 'votacao-ementa' }, (i > 0 && todos[i - 1].proposicao === x.proposicao && x.descricao) || x.ementa || x.descricao),
      ),
      el('span', { class: `voto ${classeVoto(x.voto)}` }, VOTO[x.voto] ?? x.voto),
    );
  const periodo = m.casa === 'camara' ? 'em 2025 e 2026' : 'desde fevereiro de 2023';
  return secao(
    'votos',
    'Como votou',
    el('p', {}, `${v.total.toLocaleString('pt-BR')} votações nominais no plenário ${periodo}.`),
    resumo,
    el('h3', {}, 'Votações mais recentes'),
    el('ol', { class: 'votacoes' }, ...v.lista.map(linhaVoto)),
    m.url ? el('p', { class: 'mais' }, fora(m.url, m.casa === 'camara' ? 'Todas as votações na página da Câmara' : 'Todas as votações na página do Senado')) : null,
  );
}

// ------------------------------------------------------------------ propostas

function propostas(m: Mandato): HTMLElement {
  const p = m.proposicoes;
  const tipos = [...new Set([...Object.keys(p.autor), ...Object.keys(p.coautor)])].sort(
    (a, b) => (p.autor[b] ?? 0) + (p.coautor[b] ?? 0) - ((p.autor[a] ?? 0) + (p.coautor[a] ?? 0)),
  );
  if (!tipos.length) return secao('propostas', 'Propostas', el('p', {}, 'Nenhuma proposta apresentada desde fevereiro de 2023.'));

  const tabela = el(
    'table',
    { class: 'tabela-props' },
    el('caption', { class: 'sr-only' }, 'Propostas por tipo e papel'),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Tipo'), el('th', { scope: 'col' }, 'Como autor'), el('th', { scope: 'col' }, 'Assinou junto'))),
    el(
      'tbody',
      {},
      ...tipos.map((t) =>
        el('tr', {}, el('th', { scope: 'row' }, `${TIPO[t] ?? t} (${t})`), el('td', { class: 'num' }, String(p.autor[t] ?? 0)), el('td', { class: 'num' }, String(p.coautor[t] ?? 0))),
      ),
    ),
  );

  const autor = p.lista.filter((x) => x.papel === 'autor');
  const pecs = p.lista.filter((x) => x.papel === 'coautor');
  const lista = el('ol', { class: 'props' });
  const item = (x: Proposicao) =>
    el(
      'li',
      { class: 'prop' },
      el('p', { class: 'prop-id' }, fora(x.url, `${x.sigla} ${x.numero}/${x.ano}`), x.data ? el('span', { class: 'prop-data' }, fmtDia(x.data)) : null),
      el('p', { class: 'prop-ementa' }, x.ementa),
      x.situacao ? el('p', { class: 'prop-sit' }, x.situacao) : null,
    );
  const abas = el('div', { class: 'abas', role: 'tablist', 'aria-label': 'Lista de propostas' });
  const mostrar = (qual: 'autor' | 'pecs') => {
    lista.replaceChildren(...(qual === 'autor' ? autor : pecs).map(item));
    for (const b of abas.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.aba === qual));
  };
  for (const [qual, rotulo, n] of [['autor', 'Que apresentou', autor.length], ['pecs', 'Emendas à Constituição que assinou junto', pecs.length]] as const) {
    if (!n) continue;
    const b = el('button', { type: 'button', role: 'tab', class: 'aba', 'data-aba': qual, 'aria-controls': 'props-lista' }, `${rotulo} (${n})`);
    b.addEventListener('click', () => mostrar(qual));
    abas.append(b);
  }
  lista.id = 'props-lista';
  mostrar(autor.length ? 'autor' : 'pecs');

  return secao(
    'propostas',
    'Propostas',
    el('p', {}, 'Desde fevereiro de 2023. Uma emenda à Constituição precisa da assinatura de um terço da casa, por isso muita gente aparece como quem assinou junto.'),
    tabela,
    abas,
    lista,
  );
}

// ------------------------------------------------------------------ gastos

function barras(itens: { rotulo: string; valor: number }[], classe = ''): HTMLElement {
  const max = Math.max(...itens.map((i) => i.valor), 1);
  return el(
    'ul',
    { class: `barras ${classe}` },
    ...itens.map((i) =>
      el(
        'li',
        {},
        el('span', { class: 'barra-rotulo' }, i.rotulo),
        el('span', { class: 'barra-trilho', 'aria-hidden': 'true' }, el('span', { class: 'barra', style: `width:${((i.valor / max) * 100).toFixed(1)}%` })),
        el('span', { class: 'barra-valor num' }, fmtReaisCurto(i.valor)),
      ),
    ),
  );
}

function gastos(m: Mandato): HTMLElement {
  const d: Despesas | null = m.despesas;
  const nome = m.casa === 'camara' ? 'cota parlamentar' : 'cota do Senado (CEAPS)';
  if (!d || !d.total) {
    return secao('gastos', 'Gastos com a cota', el('p', {}, `Nenhum reembolso da ${nome} desde 2023.`));
  }
  return secao(
    'gastos',
    'Gastos com a cota',
    el(
      'p',
      { class: 'gasto-total' },
      el('strong', { class: 'num' }, fmtReais(d.total)),
      ` reembolsados pela ${nome} desde 2023${d.ultima ? `, até ${fmtDia(d.ultima)}` : ''}.`,
    ),
    nota('A cota paga despesas do mandato, como passagens, escritório no estado, combustível e divulgação. Não inclui salário nem a verba de gabinete.'),
    el('h3', {}, 'Por ano'),
    barras(d.por_ano.map((a) => ({ rotulo: String(a.ano), valor: a.total })), 'barras--anos'),
    el('h3', {}, 'Com o quê'),
    barras(d.por_categoria.slice(0, 6).map((c) => ({ rotulo: c.categoria, valor: c.total }))),
    d.fornecedores.length
      ? el(
          'div',
          {},
          el('h3', {}, 'Quem mais recebeu'),
          el('ol', { class: 'fornecedores' }, ...d.fornecedores.map((f) => el('li', {}, el('span', {}, f.nome), el('span', { class: 'num' }, fmtReais(f.total))))),
        )
      : null,
  );
}

// ------------------------------------------------------------------ candidatura

function candidatura(f: Ficha, c: Candidatura | null): HTMLElement {
  if (!c) {
    return secao('candidatura', 'Eleição de 2026', el('p', {}, 'Não concorreu em 2026 para presidente, governador, senador ou deputado.'));
  }
  const fem = feminino(f);
  const linhas: [string, Node | string][] = [
    ['Cargo', `${cargoGenero(c.cargo_nome, fem)}${c.uf && c.uf !== 'BR' ? `, ${UFS[c.uf] ?? c.uf}` : ''}`],
    ['Número', urnaNumero(c.numero, CASAS[c.cargo], 'p')],
    ['Partido', `${c.partido_nome} (${c.partido})`],
  ];
  if (c.coligacao || c.composicao) linhas.push([c.coligacao ? 'Coligação' : 'Federação', [c.coligacao, c.composicao].filter(Boolean).join(': ')]);
  linhas.push(['Resultado', el('span', { class: `sit sit--${c.situacao || 'sem'}` }, SITUACAO[c.situacao])]);
  if (c.ocupacao) linhas.push(['Ocupação declarada', c.ocupacao]);
  if (c.instrucao) linhas.push(['Escolaridade', c.instrucao]);

  const dl = el('dl', { class: 'dados' }, ...linhas.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
  const b = c.bens;
  const bens = b.quantidade
    ? el(
        'div',
        { class: 'bens' },
        el('h3', {}, 'Patrimônio declarado ao TSE'),
        el('p', { class: 'gasto-total' }, el('strong', { class: 'num' }, fmtReais(b.total)), ` em ${b.quantidade} ${b.quantidade === 1 ? 'bem' : 'bens'}.`),
        el(
          'ol',
          { class: 'fornecedores' },
          ...b.maiores.map((x) => el('li', {}, el('span', {}, x.descricao || x.tipo, el('small', {}, x.tipo)), el('span', { class: 'num' }, fmtReais(x.valor)))),
        ),
        b.quantidade > b.maiores.length ? nota(`Mostrando os ${b.maiores.length} maiores valores.`) : null,
      )
    : el('p', {}, 'Não declarou bens ao TSE.');
  return secao('candidatura', 'Eleição de 2026', dl, bens);
}

// ------------------------------------------------------------------ montagem

export function montarFicha(f: Ficha): HTMLElement {
  const m = f.mandato;
  const c = f.candidatura;
  const fem = feminino(f);

  const topo = el(
    'header',
    { class: 'ficha-topo' },
    avatar(f.nome, f.foto, 'avatar avatar--g'),
    el(
      'div',
      { class: 'ficha-id' },
      m
        ? el('p', { class: 'ficha-cargo' }, `${cargoGenero(m.cargo, fem)}, ${UFS[m.uf] ?? m.uf}, ${m.partido}${m.condicao === 'Suplente' ? ', suplente em exercício' : ''}`)
        : null,
      el('h1', { class: 'ficha-nome', tabindex: -1 }, f.nome),
      f.nome_civil && f.nome_civil.toLowerCase() !== f.nome.toLowerCase() ? el('p', { class: 'ficha-civil' }, f.nome_civil) : null,
    ),
    c
      ? el(
          'div',
          { class: 'ficha-urna' },
          urnaNumero(c.numero, CASAS[c.cargo], 'g'),
          el(
            'p',
            {},
            `${fem ? 'Candidata' : 'Candidato'} a ${cargoGenero(c.cargo_nome, fem).toLowerCase()}${c.uf && c.uf !== 'BR' ? ` (${c.uf})` : ''} em 2026. `,
            el('span', { class: `sit sit--${c.situacao || 'sem'}` }, SITUACAO[c.situacao]),
          ),
        )
      : null,
  );

  const copiar = el('button', { type: 'button', class: 'btn-link' }, 'Copiar link desta ficha');
  copiar.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copiar.textContent = 'Link copiado';
    } catch {
      copiar.textContent = 'Não deu para copiar. Use a barra de endereço.';
    }
    setTimeout(() => (copiar.textContent = 'Copiar link desta ficha'), 2400);
  });

  // quem concorre ao Executivo: o plano de governo vem antes de tudo
  const plano = c?.plano ? secao('plano', 'Plano de governo', ...montarPlano(c.plano, f.nome)) : null;
  const secoes: HTMLElement[] = [
    ...(plano ? [plano] : []),
    ...(m ? [presenca(m), votos(m), propostas(m), gastos(m)] : []),
    candidatura(f, c),
  ];
  const indice = el(
    'nav',
    { class: 'ficha-indice', 'aria-label': 'Nesta ficha' },
    ...secoes.map((s) => el('a', { href: `#${s.id}` }, s.querySelector('h2')?.textContent ?? '')),
  );

  const semMandato = m
    ? null
    : el(
        'p',
        { class: 'aviso' },
        `Esta ficha mostra a candidatura${c?.plano ? ' e o plano de governo' : ''}. Presença, votos, propostas e gastos existem, por enquanto, só para deputados federais e senadores em exercício. Cargos no Executivo e mandatos estaduais e municipais ainda não estão aqui.`,
      );

  const contato = m
    ? el(
        'p',
        { class: 'ficha-contato' },
        m.url ? fora(m.url, m.casa === 'camara' ? 'Página oficial na Câmara' : 'Página oficial no Senado') : null,
        m.email ? el('a', { href: `mailto:${m.email}` }, m.email) : null,
      )
    : null;

  return el(
    'article',
    { class: 'ficha' },
    el('p', { class: 'voltar' }, el('a', { href: '?', 'data-voltar': '' }, 'Voltar para a busca')),
    topo,
    el('div', { class: 'ficha-acoes' }, contato, copiar),
    semMandato,
    indice,
    ...secoes,
    el(
      'footer',
      { class: 'ficha-fontes' },
      el('h2', {}, 'De onde vêm estes dados'),
      el('ul', {}, ...f.fontes.map((x) => el('li', {}, fora(x.url, x.nome)))),
      el('p', {}, `Atualizado em ${fmtDia(f.atualizado_em)}.`),
    ),
  );
}
