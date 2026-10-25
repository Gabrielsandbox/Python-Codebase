// Acervo: eleições passadas, histórico político de candidatos e pesquisas centralizadas.
// Três abas por hash (#eleicoes, #candidatos, #pesquisas); o estado dos filtros vive na própria
// URL (ex.: #eleicoes?ano=2022&cargo=1&turno=2) para que qualquer tela seja compartilhável.
import '../styles.css';
import './acervo.css';
import '../analytics';
import { el } from '../format';
import * as api from './api';
import type { Candidatura, Eleicao, Estado, LinhaEleicao, LinhaUf, Pessoa, PontoPesquisa } from './api';
import { barrasHorizontais, fmtInt, fmtPct, linhas } from './charts';
import { montarConta } from './conta';
import type { Barra, Serie } from './charts';

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
const CARGOS_GERAIS = [1, 3, 5, 6, 7, 8];
const CARGOS_MUNICIPAIS = [11, 13];
// Cores de partido com baixo contraste sobre fundo claro (validador da paleta) ganham um tom
// mais escuro só nos gráficos; o nome/sigla ao lado da marca carrega a identidade.
const COR_GRAFICO: Record<string, string> = { PSOL: '#a67c00', NOVO: '#c25e00' };
const COR_NEUTRA = '#7a7f8a';
const ABAS = ['eleicoes', 'candidatos', 'pesquisas'] as const;
type Aba = (typeof ABAS)[number];

let estado: Estado | null = null;
let cores: Record<string, string> = {};

const cor = (partido: string | null | undefined): string => {
  if (!partido) return COR_NEUTRA;
  return COR_GRAFICO[partido] ?? cores[partido] ?? COR_NEUTRA;
};
const nomeProprio = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .replace(/(^|[\s(\-/])(\p{L})/gu, (m) => m.toUpperCase())
    .replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const iniciais = (nome: string): string =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
const eleito = (sit: string | null | undefined): boolean => !!sit && sit.toUpperCase().startsWith('ELEITO');
const chipSituacao = (sit: string | null | undefined): HTMLElement | null => {
  if (!sit) return null;
  const s = sit.toUpperCase();
  const texto = s === 'ELEITO POR QP' ? 'Eleito (quociente)' : s === 'ELEITO POR MÉDIA' ? 'Eleito (média)' : s === '2º TURNO' ? '2º turno' : nomeProprio(s);
  return el('span', { class: `ac-chip${eleito(s) ? ' eleito' : ''}`, text: texto });
};
const nomeCargo = (cd: number): string => estado?.cargos[String(cd)] ?? `Cargo ${cd}`;
const fmtDataBr = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return iso;
};
const idade = (iso: string | null | undefined): number | null => {
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const n = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const hoje = new Date();
  let a = hoje.getFullYear() - n.getFullYear();
  if (hoje < new Date(hoje.getFullYear(), n.getMonth(), n.getDate())) a--;
  return a;
};

// ----------------------------------------------------------------------------- rota
interface Rota {
  aba: Aba;
  p: URLSearchParams;
}
function rotaAtual(): Rota {
  const h = location.hash.replace(/^#/, '');
  const [cabeca, query = ''] = h.split('?');
  if (cabeca?.startsWith('candidato=')) {
    const p = new URLSearchParams(query);
    p.set('perfil', cabeca.slice('candidato='.length));
    return { aba: 'candidatos', p };
  }
  const aba = (ABAS as readonly string[]).includes(cabeca ?? '') ? (cabeca as Aba) : 'eleicoes';
  return { aba, p: new URLSearchParams(query) };
}
function irPara(aba: Aba, p: Record<string, string | number | null | undefined>, substituir = false): void {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  const hash = `#${aba}${s ? '?' + s : ''}`;
  if (substituir) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (substituir) render();
}
const hashPerfil = (sq: string, ano: number) => `#candidato=${sq}:${ano}`;

// ----------------------------------------------------------------------------- comuns
function sel(nome: string, opcoes: Array<[string, string]>, valor: string, aoMudar: (v: string) => void): HTMLSelectElement {
  const s = el('select', { 'aria-label': nome, name: nome });
  for (const [v, t] of opcoes) s.append(el('option', { value: v, text: t, selected: v === valor ? true : undefined }));
  s.value = valor;
  s.addEventListener('change', () => aoMudar(s.value));
  return s;
}
const tile = (l: string, v: string, d?: string) => el('div', { class: 'ac-tile' }, el('div', { class: 'l', text: l }), el('div', { class: 'v num', text: v }), d ? el('div', { class: 'd', text: d }) : null);
const vazio = (texto: string) => el('div', { class: 'card ac-vazio', text: texto });
const carregando = () => el('div', { class: 'card ac-vazio', text: 'Carregando…' });
function tabela(cabecas: Array<[string, boolean?]>, linhas: Array<Array<string | HTMLElement>>): HTMLElement {
  const thead = el('thead', {}, el('tr', {}, ...cabecas.map(([t, num]) => el('th', { class: num ? 'num' : undefined, scope: 'col', text: t }))));
  const tbody = el('tbody');
  for (const l of linhas) tbody.append(el('tr', {}, ...l.map((c, i) => el('td', { class: cabecas[i]?.[1] ? 'num' : undefined }, c))));
  return el('div', { class: 'ac-tabela-wrap' }, el('table', { class: 'ac-tabela' }, thead, tbody));
}
function erro(e: unknown): HTMLElement {
  const msg = e instanceof Error ? e.message : String(e);
  return vazio(msg.includes('HTTP 404') ? 'Esses dados ainda não estão no acervo.' : `Não foi possível carregar (${msg}).`);
}

// ----------------------------------------------------------------------------- eleições
function cargosDoAno(ano: number): number[] {
  const lista = ano % 4 === 0 ? CARGOS_MUNICIPAIS : CARGOS_GERAIS;
  return lista.filter((c) => estado?.cargos[String(c)]);
}
async function renderEleicoes(raiz: HTMLElement, p: URLSearchParams): Promise<void> {
  const anos = (estado?.votacao ?? []).filter((a) => a % 4 !== 0).sort((a, b) => b - a);
  if (!anos.length) {
    raiz.replaceChildren(vazio('Nenhuma eleição carregada no acervo ainda.'));
    return;
  }
  const ano = anos.includes(Number(p.get('ano'))) ? Number(p.get('ano')) : anos[0]!;
  const cargos = cargosDoAno(ano);
  const cargo = cargos.includes(Number(p.get('cargo'))) ? Number(p.get('cargo')) : cargos[0]!;
  const temSegundo = cargo === 1 || cargo === 3;
  const turno = temSegundo && p.get('turno') === '2' ? 2 : 1;
  const nacional = cargo === 1;
  const ufParam = (p.get('uf') ?? '').toUpperCase();
  const uf = UFS.includes(ufParam) ? ufParam : nacional ? '' : 'SP';
  const atualizar = (patch: Record<string, string | number>) => irPara('eleicoes', { ano, cargo, turno, uf, ...patch });

  const filtros = el(
    'div',
    { class: 'ac-filtros' },
    sel('Ano', anos.map((a) => [String(a), String(a)]), String(ano), (v) => atualizar({ ano: v, uf: '' })),
    sel('Cargo', cargos.map((c) => [String(c), nomeCargo(c)]), String(cargo), (v) => atualizar({ cargo: v, turno: 1, uf: Number(v) === 1 ? '' : uf || 'SP' })),
    temSegundo ? sel('Turno', [['1', '1º turno'], ['2', '2º turno']], String(turno), (v) => atualizar({ turno: v })) : null,
    sel('UF', [...(nacional ? [['', 'Brasil']] : []), ...UFS.map((u) => [u, u])] as Array<[string, string]>, uf, (v) => atualizar({ uf: v })),
  );
  const corpo = el('div', { class: 'acervo-sec' }, carregando());
  raiz.replaceChildren(filtros, corpo);

  try {
    const [e, ufs] = await Promise.all([api.eleicao(ano, cargo, turno, uf || undefined), nacional && !uf ? api.eleicaoUfs(ano, cargo, turno) : Promise.resolve(null)]);
    corpo.replaceChildren(...cartoesEleicao(e, uf, ufs?.itens ?? null));
  } catch (ex) {
    corpo.replaceChildren(erro(ex));
  }
}
function cartoesEleicao(e: Eleicao, uf: string, ufs: LinhaUf[] | null): HTMLElement[] {
  const titulo = `${e.cargo_nome} · ${e.ano} · ${e.turno}º turno${uf ? ' · ' + uf : ''}`;
  const saida: HTMLElement[] = [];
  const cands = e.candidatos;
  if (!cands.length) return [vazio('Sem votos registrados para esse recorte.')];
  const majoritario = [1, 3, 5, 11].includes(e.cargo);
  const lider = cands[0]!;

  // cabeçalho + vencedor (ou líder, em recorte por UF de eleição nacional)
  const venc = el(
    'div',
    { class: 'ac-vencedor', style: `border-color:${cor(lider.sg_partido)}` },
    el('span', { class: 'sw', style: `background:${cor(lider.sg_partido)}`, 'aria-hidden': 'true', text: lider.nr_candidato ? String(lider.nr_candidato) : iniciais(lider.nm_urna_candidato) }),
    el('div', {}, el('b', {}, el('a', { href: hashPerfil(lider.sq_candidato, e.ano), text: nomeProprio(lider.nm_urna_candidato) })), el('div', { class: 'ac-perfil-meta' }, `${lider.sg_partido ?? ''} · ${eleito(lider.ds_sit_tot_turno) && !uf ? 'Eleito' : 'Mais votado'}${majoritario ? '' : ' (nominal)'}`)),
    el('span', { class: 'pct num', text: lider.pct != null ? fmtPct(lider.pct) : fmtInt(lider.votos) }),
  );
  const cab = el('section', { class: 'card ac-card' }, el('h2', { text: titulo }), el('p', { class: 'ac-lead', text: majoritario ? 'Votos nominais somados dos boletins de urna por município. Percentual sobre os votos válidos nominais.' : 'Candidatos mais votados nominalmente. Em eleições proporcionais, a eleição depende também do quociente partidário.' }), venc);
  saida.push(cab);

  // totais
  if (e.totais) {
    const t = e.totais;
    const pc = (n: number, base: number) => (base ? fmtPct((100 * n) / base) : '—');
    saida.push(
      el(
        'section',
        { class: 'card ac-card' },
        el('h3', { text: 'Participação' }),
        el('div', { class: 'ac-tiles' }, tile('Aptos', fmtInt(t.aptos)), tile('Comparecimento', pc(t.comparecimento, t.aptos), fmtInt(t.comparecimento)), tile('Abstenção', pc(t.abstencoes, t.aptos), fmtInt(t.abstencoes)), tile('Brancos', pc(t.brancos, t.comparecimento), fmtInt(t.brancos)), tile('Nulos', pc(t.nulos, t.comparecimento), fmtInt(t.nulos)), tile('Válidos nominais', fmtInt(t.validos_nominais))),
      ),
    );
  }

  // barras + tabela
  const topo = majoritario ? cands : cands.slice(0, 15);
  const barras: Barra[] = topo.map((c, i) => ({ rotulo: nomeProprio(c.nm_urna_candidato), sub: `${c.sg_partido ?? ''}${c.nr_candidato ? ' · ' + c.nr_candidato : ''}`, valor: c.votos, pct: c.pct, cor: cor(c.sg_partido), destaque: i === 0 }));
  const graf = el('div', { class: 'ac-grafico' });
  barrasHorizontais(graf, barras);
  graf.querySelectorAll<HTMLElement>('.ch-barra').forEach((linha, i) => {
    const c = topo[i]!;
    linha.style.cursor = 'pointer';
    linha.setAttribute('role', 'link');
    linha.tabIndex = 0;
    const ir = () => (location.hash = hashPerfil(c.sq_candidato, e.ano));
    linha.addEventListener('click', ir);
    linha.addEventListener('keydown', (ev) => ev.key === 'Enter' && ir());
  });
  const linhasTab = cands.map((c: LinhaEleicao, i) => [String(i + 1), el('a', { href: hashPerfil(c.sq_candidato, e.ano), text: nomeProprio(c.nm_urna_candidato) }), c.sg_partido ?? '—', c.nr_candidato != null ? String(c.nr_candidato) : '—', fmtInt(c.votos), c.pct != null ? fmtPct(c.pct) : '—', chipSituacao(c.ds_sit_tot_turno) ?? '—']);
  saida.push(
    el(
      'section',
      { class: 'card ac-card' },
      el('h3', { text: majoritario ? 'Votos por candidato' : `Os ${topo.length} mais votados` }),
      graf,
      el('details', { class: 'ac-tab' }, el('summary', { text: majoritario ? `Ver tabela completa (${cands.length} candidatos)` : `Ver tabela com os ${cands.length} mais votados` }), tabela([['#'], ['Candidato'], ['Partido'], ['Nº', true], ['Votos', true], ['%', true], ['Situação']], linhasTab)),
    ),
  );

  // mapa por UF (eleição nacional)
  if (ufs && ufs.length) {
    const porUf = new Map<string, LinhaUf[]>();
    for (const l of ufs) porUf.set(l.sg_uf, [...(porUf.get(l.sg_uf) ?? []), l]);
    const grade = el('div', { class: 'ac-ufs' });
    for (const u of UFS) {
      const ls = porUf.get(u);
      if (!ls?.length) continue;
      const l = ls[0]!;
      const pct = l.total ? (100 * l.votos) / l.total : 0;
      const bloco = el('a', { class: 'ac-uf', href: `#eleicoes?${new URLSearchParams({ ano: String(e.ano), cargo: String(e.cargo), turno: String(e.turno), uf: u })}`, style: `background:${cor(l.partido)}` }, el('b', { text: u }), `${nomeProprio(l.nome)} ${fmtPct(pct, 0)}`);
      bloco.title = ls.map((x) => `${nomeProprio(x.nome)} (${x.partido ?? '—'}): ${fmtPct(x.total ? (100 * x.votos) / x.total : 0)}`).join(' · ');
      grade.append(bloco);
    }
    const legenda = el('div', { class: 'ch-legenda' }, ...[...new Set(ufs.filter((l) => l.pos === 1).map((l) => `${l.nome}|${l.partido ?? ''}`))].map((k) => {
      const [n, pt] = k.split('|');
      return el('span', { class: 'ch-leg' }, el('i', { style: `background:${cor(pt)}`, 'aria-hidden': 'true' }), `${nomeProprio(n)} (${pt || '—'})`);
    }));
    saida.push(el('section', { class: 'card ac-card' }, el('h3', { text: 'Quem venceu em cada estado' }), el('p', { class: 'ac-lead', text: 'Toque num estado para ver o resultado detalhado nele.' }), grade, legenda));
  }
  return saida;
}

// ----------------------------------------------------------------------------- candidatos
let buscaTimer: number | undefined;
async function renderCandidatos(raiz: HTMLElement, p: URLSearchParams): Promise<void> {
  const perfil = p.get('perfil');
  if (perfil) {
    const [sq, anoS] = perfil.split(':');
    await renderPerfil(raiz, sq ?? '', Number(anoS));
    return;
  }
  const q = p.get('q') ?? '';
  const anos = [...(estado?.candidatos ?? [])].sort((a, b) => b - a);
  const ano = anos.includes(Number(p.get('ano'))) ? Number(p.get('ano')) : 0;
  const cargo = Number(p.get('cargo')) || 0;
  const uf = (p.get('uf') ?? '').toUpperCase();
  const atualizar = (patch: Record<string, string | number>, substituir = false) => irPara('candidatos', { q, ano: ano || '', cargo: cargo || '', uf, ...patch }, substituir);

  const input = el('input', { type: 'search', placeholder: 'Nome do candidato (ex.: Lula, Tarcísio, Marina)', value: q, autocomplete: 'off', 'aria-label': 'Buscar candidato' });
  input.addEventListener('input', () => {
    window.clearTimeout(buscaTimer);
    buscaTimer = window.setTimeout(() => atualizar({ q: input.value.trim() }, true), 350);
  });
  const filtros = el(
    'div',
    { class: 'ac-filtros' },
    el('div', { class: 'ac-busca' }, input),
    sel('Ano', [['', 'Todos os anos'], ...anos.map((a) => [String(a), String(a)] as [string, string])], ano ? String(ano) : '', (v) => atualizar({ ano: v })),
    sel('Cargo', [['', 'Todos os cargos'], ...Object.entries(estado?.cargos ?? {}).map(([c, n]) => [c, n] as [string, string])], cargo ? String(cargo) : '', (v) => atualizar({ cargo: v })),
    sel('UF', [['', 'Todas as UFs'], ...UFS.map((u) => [u, u] as [string, string])], uf, (v) => atualizar({ uf: v })),
  );
  const corpo = el('div', { class: 'acervo-sec' });
  raiz.replaceChildren(filtros, corpo);
  if (document.activeElement !== input && !perfil) input.focus({ preventScroll: true });
  if (q.length < 3) {
    corpo.append(el('section', { class: 'card ac-card' }, el('h2', { text: 'Histórico político' }), el('p', { class: 'ac-lead', text: `Digite pelo menos 3 letras. O acervo cobre as candidaturas de ${anos.length ? anos.slice().reverse().join(', ') : '—'} com votos, partido, coligação e resultado, a partir dos dados abertos do TSE.` })));
    return;
  }
  corpo.append(carregando());
  try {
    const { itens } = await api.buscar(q, { ano: ano || undefined, cargo: cargo || undefined, uf: uf || undefined });
    if (input.value.trim() !== q) return; // o usuário já digitou outra coisa
    if (!itens.length) {
      corpo.replaceChildren(vazio(`Nenhuma candidatura encontrada para “${q}”.`));
      return;
    }
    const lista = el('div', { class: 'ac-lista', role: 'list' });
    for (const c of itens) {
      const item = el(
        'button',
        { class: 'ac-item', type: 'button', role: 'listitem' },
        el('span', { class: 'sw', style: `background:${cor(c.sg_partido)}`, 'aria-hidden': 'true', text: c.sg_partido ? c.sg_partido.slice(0, 4) : iniciais(c.nm_urna_candidato) }),
        el('div', {}, el('div', { class: 'n', text: nomeProprio(c.nm_urna_candidato) }), el('div', { class: 'm', text: `${nomeProprio(c.nm_candidato)} · ${c.ano} · ${nomeProprio(c.ds_cargo)} · ${c.sg_uf}${c.votos != null ? ' · ' + fmtInt(c.votos) + ' votos' : ''}` })),
        chipSituacao(c.ds_sit_tot_turno),
      );
      item.addEventListener('click', () => (location.hash = hashPerfil(c.sq_candidato, c.ano)));
      lista.append(item);
    }
    corpo.replaceChildren(el('p', { class: 'ac-lead', text: `${itens.length} candidatura${itens.length > 1 ? 's' : ''}${itens.length >= 30 ? ' (refine a busca para ver mais)' : ''}` }), lista);
  } catch (ex) {
    corpo.replaceChildren(erro(ex));
  }
}

async function renderPerfil(raiz: HTMLElement, sq: string, ano: number): Promise<void> {
  const voltar = el('a', { class: 'btn ac-voltar', href: '#candidatos' }, '← Buscar outro candidato');
  const corpo = el('div', { class: 'acervo-sec' }, carregando());
  raiz.replaceChildren(voltar, corpo);
  try {
    const h = await api.pessoa(sq, ano);
    corpo.replaceChildren(...cartoesPerfil(h));
  } catch (ex) {
    corpo.replaceChildren(erro(ex));
  }
}
function cartoesPerfil(h: Pessoa): HTMLElement[] {
  const pf = h.perfil;
  const cands = [...h.candidaturas].sort((a, b) => b.ano - a.ano || b.turno - a.turno);
  const atual = cands[0];
  const partido = atual?.sg_partido ?? null;
  const anosIdade = idade(pf.dt_nascimento);
  const meta = [
    pf.dt_nascimento ? `Nascimento: ${fmtDataBr(pf.dt_nascimento)}${anosIdade != null ? ` (${anosIdade} anos)` : ''}${pf.sg_uf_nascimento ? ` · ${pf.nm_municipio_nascimento ? nomeProprio(pf.nm_municipio_nascimento) + '/' : ''}${pf.sg_uf_nascimento}` : ''}` : null,
    pf.ds_ocupacao ? `Ocupação: ${nomeProprio(pf.ds_ocupacao)}` : null,
    pf.ds_grau_instrucao ? `Instrução: ${nomeProprio(pf.ds_grau_instrucao)}` : null,
    [pf.ds_genero, pf.ds_cor_raca].filter(Boolean).map((s) => nomeProprio(s)).join(' · ') || null,
  ].filter((s): s is string => !!s);
  const r = h.resumo;
  const cab = el(
    'section',
    { class: 'card ac-card' },
    el('div', { class: 'ac-perfil-head' }, el('span', { class: 'sw', style: `background:${cor(partido)}`, 'aria-hidden': 'true', text: iniciais(pf.nm_urna_candidato || pf.nm_candidato) }), el('div', {}, el('h2', { text: nomeProprio(pf.nm_urna_candidato || pf.nm_candidato) }), el('div', { class: 'ac-perfil-meta', text: `${nomeProprio(pf.nm_candidato)}${pf.nm_social_candidato ? ' · nome social: ' + nomeProprio(pf.nm_social_candidato) : ''}` }))),
    ...meta.map((m) => el('div', { class: 'ac-perfil-meta', text: m })),
    el('h3', { text: 'Resumo' }),
    el('div', { class: 'ac-tiles' }, tile('Candidaturas', fmtInt(r.candidaturas), r.primeiro_ano && r.ultimo_ano ? (r.primeiro_ano === r.ultimo_ano ? String(r.primeiro_ano) : `${r.primeiro_ano}–${r.ultimo_ano}`) : undefined), tile('Eleições vencidas', fmtInt(r.eleicoes_vencidas)), tile(r.partidos.length > 1 ? 'Partidos' : 'Partido', r.partidos.join(', ') || '—')),
  );
  const saida = [cab];

  const comVotos = cands.filter((c) => c.votos != null);
  if (comVotos.length) {
    const barras: Barra[] = comVotos.map((c) => ({ rotulo: `${c.ano} · ${c.turno}º turno`, sub: `${nomeProprio(c.ds_cargo)} · ${c.sg_uf}${c.sg_partido ? ' · ' + c.sg_partido : ''}`, valor: c.votos ?? 0, cor: cor(c.sg_partido), destaque: eleito(c.ds_sit_tot_turno) }));
    const graf = el('div', { class: 'ac-grafico' });
    barrasHorizontais(graf, barras);
    saida.push(el('section', { class: 'card ac-card' }, el('h3', { text: 'Votos por eleição' }), el('p', { class: 'ac-lead', text: 'Barras destacadas marcam eleições em que foi eleito.' }), graf));
  }
  const linhasTab = cands.map((c: Candidatura) => [String(c.ano), `${c.turno}º`, nomeProprio(c.ds_cargo), `${c.sg_uf}${c.nm_ue && c.cd_cargo >= 11 ? ' · ' + nomeProprio(c.nm_ue) : ''}`, c.sg_partido ?? '—', c.nr_candidato != null ? String(c.nr_candidato) : '—', c.votos != null ? fmtInt(c.votos) : '—', chipSituacao(c.ds_sit_tot_turno) ?? (c.ds_situacao_candidatura ? nomeProprio(c.ds_situacao_candidatura) : '—')]);
  saida.push(
    el('section', { class: 'card ac-card' }, el('h3', { text: 'Candidaturas' }), tabela([['Ano'], ['Turno'], ['Cargo'], ['UF'], ['Partido'], ['Nº', true], ['Votos', true], ['Resultado']], linhasTab),
      ...cands.filter((c) => c.nm_coligacao || c.ds_composicao_coligacao).slice(0, 1).map((c) => el('p', { class: 'ac-perfil-meta', text: `Coligação em ${c.ano}: ${nomeProprio(c.nm_coligacao) || '—'}${c.ds_composicao_coligacao ? ' (' + c.ds_composicao_coligacao + ')' : ''}` }))),
  );
  return saida;
}

// ----------------------------------------------------------------------------- pesquisas
async function renderPesquisas(raiz: HTMLElement, p: URLSearchParams): Promise<void> {
  const disp = estado?.pesquisas ?? [];
  if (!disp.length) {
    raiz.replaceChildren(
      el('section', { class: 'card ac-card' }, el('h2', { text: 'Pesquisas eleitorais' }), el('p', { class: 'ac-lead', text: 'Em breve: as pesquisas registradas no TSE reunidas num só lugar, por eleição e cenário, com a evolução de cada candidato ao longo da campanha.' })),
    );
    return;
  }
  const chave = (d: { ano: number; cargo: number; uf: string }) => `${d.ano}:${d.cargo}:${d.uf}`;
  const opcoes: Array<[string, string]> = disp.map((d) => [chave(d), `${d.ano} · ${nomeCargo(d.cargo)} · ${d.uf || 'Brasil'} (${d.pontos} pontos)`]);
  const sel0 = opcoes.find(([k]) => k === p.get('e'))?.[0] ?? opcoes[0]![0];
  const [anoS, cargoS, uf] = sel0.split(':');
  const ano = Number(anoS);
  const cargo = Number(cargoS);
  const turno = p.get('turno') === '2' ? 2 : 1;
  const cenario = p.get('cenario') ?? '';
  const atualizar = (patch: Record<string, string | number>) => irPara('pesquisas', { e: sel0, turno, cenario, ...patch });

  const filtros = el('div', { class: 'ac-filtros' }, sel('Eleição', opcoes, sel0, (v) => atualizar({ e: v, cenario: '' })), sel('Turno', [['1', '1º turno'], ['2', '2º turno']], String(turno), (v) => atualizar({ turno: v })));
  const corpo = el('div', { class: 'acervo-sec' }, carregando());
  raiz.replaceChildren(filtros, corpo);
  try {
    const { pontos } = await api.pesquisas(ano, cargo, uf ?? '', turno);
    if (!pontos.length) {
      corpo.replaceChildren(vazio('Sem pesquisas para esse turno.'));
      return;
    }
    const cenarios = [...new Set(pontos.map((x) => x.cenario ?? ''))].sort();
    const cenAtivo = cenarios.includes(cenario) ? cenario : cenarios[0]!;
    if (cenarios.length > 1) filtros.append(sel('Cenário', cenarios.map((c) => [c, c || 'Principal']), cenAtivo, (v) => atualizar({ cenario: v })));
    const sub = pontos.filter((x) => (x.cenario ?? '') === cenAtivo);
    const ultimo = (xs: PontoPesquisa[]) => [...xs].sort((a, b) => a.data_divulgacao.localeCompare(b.data_divulgacao))[xs.length - 1];
    const porCand = new Map<string, PontoPesquisa[]>();
    for (const x of sub) porCand.set(x.candidato, [...(porCand.get(x.candidato) ?? []), x]);
    const ordem = [...porCand.entries()].sort((a, b) => (ultimo(b[1])?.percentual ?? 0) - (ultimo(a[1])?.percentual ?? 0));
    const series: Serie[] = ordem.map(([nome, xs]) => ({ nome: nomeProprio(nome), cor: cor(xs[0]?.partido), pontos: xs.map((x) => ({ x: new Date(x.data_divulgacao), y: x.percentual, extra: `${x.instituto}${x.margem != null ? ' ±' + x.margem : ''}` })) }));
    const graf = el('div', { class: 'ac-grafico' });
    const ultimas = ordem.map(([nome, xs]) => ({ nome, x: ultimo(xs)! }));
    const linhasTab = [...sub]
      .sort((a, b) => b.data_divulgacao.localeCompare(a.data_divulgacao) || a.candidato.localeCompare(b.candidato))
      .map((x) => [fmtDataBr(x.data_divulgacao), x.instituto, nomeProprio(x.candidato), x.partido ?? '—', fmtPct(x.percentual), x.margem != null ? `±${x.margem}` : '—', x.amostra != null ? fmtInt(x.amostra) : '—', x.registro_tse ? (x.fonte_url ? el('a', { href: x.fonte_url, target: '_blank', rel: 'noopener', text: x.registro_tse }) : x.registro_tse) : '—']);
    corpo.replaceChildren(
      el('section', { class: 'card ac-card' }, el('h2', { text: `${nomeCargo(cargo)} · ${ano} · ${uf || 'Brasil'} · ${turno}º turno${cenAtivo ? ' · ' + cenAtivo : ''}` }), el('p', { class: 'ac-lead', text: 'Percentuais como divulgados por cada instituto (votos totais, salvo indicação). Registro no TSE na tabela.' }), el('div', { class: 'ac-tiles' }, ...ultimas.slice(0, 6).map((u) => tile(nomeProprio(u.nome), fmtPct(u.x.percentual), `${u.x.instituto} · ${fmtDataBr(u.x.data_divulgacao)}`)))),
      el('section', { class: 'card ac-card' }, el('h3', { text: 'Evolução' }), graf, el('details', { class: 'ac-tab' }, el('summary', { text: `Ver tabela (${sub.length} registros)` }), tabela([['Divulgação'], ['Instituto'], ['Candidato'], ['Partido'], ['%', true], ['Margem', true], ['Amostra', true], ['Registro TSE']], linhasTab))),
    );
    linhas(graf, series);
  } catch (ex) {
    corpo.replaceChildren(erro(ex));
  }
}

// ----------------------------------------------------------------------------- app
let renderId = 0;
const conta = montarConta(document.getElementById('conta')!, () => void render());
let abaPedida: string | null = null;
async function render(): Promise<void> {
  const id = ++renderId;
  const { aba, p } = rotaAtual();
  const logado = !!conta.sessao();
  document.querySelectorAll<HTMLAnchorElement>('.acervo-abas a').forEach((a) => {
    if (a.dataset.aba === aba && logado) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  for (const nome of ABAS) {
    const sec = document.getElementById(`sec-${nome}`)!;
    sec.hidden = !logado || nome !== aba;
  }
  const portao = document.getElementById('sec-entrar')!;
  portao.hidden = logado;
  if (!logado) {
    // sem conta: só o portão (landing + criar conta / entrar); guarda a aba pedida para depois
    if (location.hash && location.hash !== '#entrar') abaPedida = location.hash;
    if (!portao.childElementCount) portao.append(conta.portao());
    document.title = 'Entrar — Acervo · Apuração ao Vivo';
    return;
  }
  if (abaPedida) {
    const h = abaPedida;
    abaPedida = null;
    if (location.hash !== h) {
      location.hash = h;
      return;
    }
  }
  const raiz = document.getElementById(`sec-${aba}`)!;
  const perfil = p.get('perfil');
  document.title = `${aba === 'eleicoes' ? 'Eleições' : aba === 'candidatos' ? (perfil ? 'Candidato' : 'Candidatos') : 'Pesquisas'} — Acervo · Apuração ao Vivo`;
  if (!estado) raiz.replaceChildren(carregando());
  try {
    if (!estado) [estado, cores] = await Promise.all([api.estado(), api.cores()]);
  } catch {
    raiz.replaceChildren(
      el('section', { class: 'card ac-card' }, el('h2', { text: 'A base de dados está sendo preparada' }), el('p', { class: 'ac-lead', text: 'Sua conta já está criada. Os dados das eleições de 2018 e 2022 entram no ar em breve; volte daqui a pouco ou acompanhe a apuração de hoje na página inicial.' }), el('p', {}, el('a', { class: 'btn', href: '/', text: 'Ver a apuração ao vivo' }))),
    );
    return;
  }
  if (id !== renderId) return;
  if (aba === 'eleicoes') await renderEleicoes(raiz, p);
  else if (aba === 'candidatos') await renderCandidatos(raiz, p);
  else await renderPesquisas(raiz, p);
}
window.addEventListener('hashchange', () => void render());
void conta.concluirLink().then(() => render());
export {};
