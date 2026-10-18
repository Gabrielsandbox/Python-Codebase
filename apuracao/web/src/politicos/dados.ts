// Contrato de ../../docs/POLITICOS.md: indice.json (linhas compactas) e p/{id}.json (ficha).

const BASE: string =
  ((import.meta.env.VITE_DADOS_BASE as string | undefined)?.replace(/\/$/, '') || '/dados') + '/politicos';

export type Situacao = 'eleito' | '2turno' | 'nao_eleito' | 'suplente' | '';

export interface ItemIndice {
  id: string;
  nome: string;
  cargo: string; // código do TSE ("1", "3", "5", "6", "7", "8") ou "" (só mandato, não concorreu)
  uf: string;
  partido: string;
  numero: string;
  situacao: Situacao;
  mandato: '' | 'd' | 's';
  chave: string; // nome normalizado para a busca
}

export interface Indice {
  gerado_em: string;
  cargos: Record<string, string>;
  itens: ItemIndice[];
}

export interface Proposicao {
  sigla: string;
  numero: number | string;
  ano: number | string;
  ementa: string;
  data: string | null;
  situacao: string;
  url: string;
  papel: 'autor' | 'coautor';
}

export interface Voto {
  data: string;
  proposicao?: string | null;
  ementa?: string;
  descricao: string;
  aprovada: boolean;
  voto: string;
  url?: string | null;
}

export interface Despesas {
  total: number;
  por_ano: { ano: number; total: number }[];
  por_categoria: { categoria: string; total: number }[];
  fornecedores: { nome: string; total: number }[];
  ultima: string | null;
}

export interface PresencaCamara {
  desde: string;
  sessoes: number;
  presente: number;
  por_ano: { ano: number; sessoes: number; presente: number }[];
  linha: string; // uma letra por sessão: p presente, a ausente
}

export interface PresencaSenado {
  desde: string | null;
  votacoes: number;
  presente: number;
  justificada: number;
  sem_justificativa: number;
  outros: number;
  por_ano: { ano: number; votacoes: number; presente: number }[];
  linha: string; // uma letra por votação: p presente, j justificada, a sem justificativa, o outros
}

export interface Mandato {
  casa: 'camara' | 'senado';
  cargo: string;
  nome: string;
  partido: string;
  uf: string;
  foto: string | null;
  condicao: string | null;
  fim_mandato?: string | null;
  url: string | null;
  email: string | null;
  redes: string[];
  presenca: PresencaCamara | PresencaSenado | null;
  proposicoes: { autor: Record<string, number>; coautor: Record<string, number>; lista: Proposicao[] };
  votos: { total: number; por_voto: Record<string, number>; lista: Voto[] };
  despesas: Despesas | null;
}

export interface Candidatura {
  ano: number;
  cargo: string;
  cargo_nome: string;
  uf: string;
  numero: string;
  partido: string;
  partido_nome: string;
  coligacao: string;
  composicao: string;
  situacao: Situacao;
  segundo_turno: boolean;
  ocupacao: string;
  instrucao: string;
  genero: string;
  nascimento: string | null;
  bens: { total: number; quantidade: number; maiores: { tipo: string; descricao: string; valor: number }[] };
  plano?: PlanoResumo | null; // só quem concorre ao Executivo registra
}

export interface PlanoResumo {
  json: string; // caminho relativo a /politicos
  partes: { pdf: string; paginas: number; bytes: number }[]; // quase sempre uma; o TSE aceita várias
  paginas: number;
  bytes: number;
}

export interface PlanoDocumento {
  pdf: string;
  bytes: number;
  paginas: string[]; // texto extraído de cada página, na ordem do PDF
  titulos: { t: string; p: number }[]; // p: página do PDF (1..n)
}

export interface Plano {
  id: string;
  documentos: PlanoDocumento[];
  atualizado_em: string;
  fonte: { nome: string; url: string };
}

export interface Ficha {
  id: string;
  nome: string;
  nome_civil: string;
  foto: string | null;
  candidatura: Candidatura | null;
  mandato: Mandato | null;
  atualizado_em: string;
  fontes: { nome: string; url: string }[];
}

export class ErroDados extends Error {
  constructor(public status: number, url: string) {
    super(`${status} em ${url}`);
  }
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new ErroDados(r.status, url);
  return (await r.json()) as T;
}

/** "José Sérgio" → "jose sergio" (mesma regra de politicos/texto.py:chave). */
export function normalizar(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let indice: Promise<Indice> | null = null;

export function carregarIndice(): Promise<Indice> {
  indice ??= getJson<{ gerado_em: string; cargos: Record<string, string>; itens: string[][] }>(
    `${BASE}/indice.json`,
  )
    .then((bruto) => ({
      gerado_em: bruto.gerado_em,
      cargos: bruto.cargos,
      itens: bruto.itens.map(([id, nome, cargo, uf, partido, numero, situacao, mandato]) => ({
        id,
        nome,
        cargo,
        uf,
        partido,
        numero,
        situacao: situacao as Situacao,
        mandato: mandato as ItemIndice['mandato'],
        chave: normalizar(nome),
      })),
    }))
    .catch((e) => {
      indice = null; // deixa tentar de novo
      throw e;
    });
  return indice;
}

/** Caminho publicado pelo coletor ("planos/x.pdf") -> URL. */
export function urlDados(rel: string): string {
  return `${BASE}/${rel.replace(/^\/+/, '')}`;
}

export function carregarPlano(r: PlanoResumo): Promise<Plano> {
  return getJson<Plano>(urlDados(r.json));
}

export function carregarFicha(id: string): Promise<Ficha> {
  if (!/^[0-9a-z]{1,20}$/.test(id)) return Promise.reject(new ErroDados(404, id));
  return getJson<Ficha>(`${BASE}/p/${id}.json`);
}

// ------------------------------------------------------------------ busca

export interface Filtros {
  texto: string;
  cargo: string; // "" = todos; "m" = só quem tem mandato no Congresso
  uf: string;
}

const PESO_CARGO: Record<string, number> = { '1': 0, '3': 1, '5': 2, '6': 3, '': 3, '8': 4, '7': 5 };
const PESO_SITUACAO: Record<string, number> = { eleito: 0, '2turno': 0, suplente: 2, nao_eleito: 2, '': 3 };

/**
 * Ranking simples e previsível: número de urna exato > alguma palavra do nome começando pelo
 * texto > contém o texto. Empates: quem tem mandato, cargo mais alto,
 * eleito antes de não eleito.
 */
export function buscar(itens: ItemIndice[], f: Filtros, limite = 60): { lista: ItemIndice[]; total: number } {
  const q = normalizar(f.texto);
  const digitos = /^\d+$/.test(q) ? q : '';
  const termos = digitos ? [] : q.split(' ').filter(Boolean);
  const achados: { item: ItemIndice; nota: number }[] = [];
  for (const it of itens) {
    if (f.uf && it.uf !== f.uf && !(f.uf === 'BR' && it.cargo === '1')) continue;
    if (f.cargo === 'm' ? !it.mandato : f.cargo && it.cargo !== f.cargo) continue;
    let nota: number;
    if (digitos) {
      if (!it.numero.startsWith(digitos)) continue;
      nota = it.numero === digitos ? 0 : 1;
    } else if (termos.length) {
      if (!termos.every((t) => it.chave.includes(t))) continue;
      // "silva" acha Marina Silva tão bem quanto Silvana: sobrenome é o jeito comum de procurar
      const palavras = ` ${it.chave}`;
      nota = termos.every((t) => palavras.includes(` ${t}`)) ? 0 : 1;
    } else {
      nota = 0;
    }
    nota = nota * 100 + (it.mandato ? 0 : 20) + (PESO_CARGO[it.cargo] ?? 6) * 3 + (PESO_SITUACAO[it.situacao] ?? 3);
    achados.push({ item: it, nota });
  }
  achados.sort((a, b) => a.nota - b.nota || a.item.chave.localeCompare(b.item.chave));
  return { lista: achados.slice(0, limite).map((a) => a.item), total: achados.length };
}
