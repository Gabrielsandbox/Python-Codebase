// Tipos do contrato de dados (docs/SCHEMA.md). Todos os arquivos têm `schema: 1`.

export interface Ativo {
  schema: 1;
  prefixo: string;
  eleicao: string;
  cargo: string;
  turno: number;
  data_eleicao: string;
}

export interface Candidato {
  numero: string;
  nome: string;
  nome_completo: string;
  partido: string;
  coligacao: string;
  vice: string;
  cor: string;
  foto: string | null;
}

export interface Meta {
  schema: 1;
  eleicao: string;
  pleito: string;
  ciclo: string;
  turno: number;
  cargo: string;
  cargo_nome: string;
  data_eleicao: string;
  atualizado_em: string;
  cands: string[];
  candidatos: Record<string, Candidato>;
  /** URLs dos JSONs oficiais do TSE (docs/RECURSOS.md §4); ausente em snapshots antigos. */
  fonte?: MetaFonte;
}

export interface MetaFonte {
  catalogo?: string;
  br?: string;
  /** Template com `{uf}` (minúsculo). */
  uf?: string;
  /** Template com `{uf}` (minúsculo) e `{tse}` (código TSE de 5 dígitos). */
  municipio?: string;
}

export interface Secoes {
  total: number;
  totalizadas: number;
  pct: number;
}

export interface Eleitorado {
  aptos: number;
  comparecimento: number;
  abstencao: number;
  pct_comparecimento: number;
  pct_abstencao: number;
}

export interface Votos {
  total: number;
  validos: number;
  brancos: number;
  nulos: number;
  pct_validos: number;
  pct_brancos: number;
  pct_nulos: number;
}

/** Bloco de resultado comum a br.json, uf/{sigla}.json e entradas de uf.json. */
export interface Resultado {
  nome: string;
  secoes: Secoes;
  eleitorado: Eleitorado;
  votos: Votos;
  v: number[];
  pct: number[];
  lider: string | null;
  margem_votos: number;
  margem_pct: number;
  situacao: Record<string, string>;
  definido: boolean;
  /** URL do JSON oficial do TSE já resolvida (docs/RECURSOS.md §4). */
  fonte?: string;
}

export interface Br extends Resultado {
  schema: 1;
  nivel: 'br' | 'uf';
  codigo: string;
  atualizado_em: string;
  cands: string[];
}

export interface UfEntry extends Resultado {
  ibge: string | null;
}

export interface Uf {
  schema: 1;
  atualizado_em: string;
  cands: string[];
  ufs: Record<string, UfEntry>;
}

export type MunLinha = [
  ibge: string,
  uf: string,
  secoes_total: number,
  secoes_totalizadas: number,
  aptos: number,
  comparecimento: number,
  validos: number,
  brancos: number,
  nulos: number,
  v: number[],
];

export interface Mun {
  schema: 1;
  atualizado_em: string;
  cands: string[];
  campos: string[];
  linhas: MunLinha[];
}

export interface TimelinePonto {
  t: string;
  secoes_pct: number;
  v: number[];
  pct: number[];
}

export interface Timeline {
  schema: 1;
  cands: string[];
  pontos: TimelinePonto[];
}

/** caminho.json — aritmética dos votos que faltam (docs/RECURSOS.md §1). */
export interface CaminhoLugar {
  votos_est: number;
  secoes: number;
  pct_secoes_restantes: number;
  /** Divisão do 1º turno só entre os dois finalistas, na ordem de `cands`. */
  base_pct: [number, number] | number[];
}
export interface CaminhoMunicipio {
  ibge: string;
  nome: string;
  uf: string;
  votos_est: number;
  pct_secoes: number;
  base_pct: [number, number] | number[];
}
export interface Caminho {
  schema: 1;
  atualizado_em: string;
  base: { eleicao: string; descricao: string };
  cands: string[];
  restante: { votos_est: number; secoes: number; pct_secoes: number; municipios_abertos: number };
  necessario: Record<string, number | null>;
  definido_matematicamente: string | null;
  por_regiao: Record<string, CaminhoLugar>;
  por_uf: Record<string, CaminhoLugar>;
  maiores_abertos: CaminhoMunicipio[];
}

/** ritmo.json — velocidade da apuração (docs/RECURSOS.md §2). */
export interface Ritmo {
  schema: 1;
  atualizado_em: string;
  secoes_por_min: number;
  votos_por_min: number;
  janela_min: number;
  amostras: number;
  eta_90: string | null;
  eta_100: string | null;
  inicio: string | null;
  fase: 'aguardando' | 'acelerando' | 'ritmo' | 'cauda' | 'concluida';
}

export interface Status {
  schema: 1;
  ultima_coleta: string;
  ultima_mudanca: string;
  fonte_idg: string;
  ciclo_ms: number;
  erros_ciclo: number;
  municipios_coletados: number;
  aguardando_totalizacao?: boolean;
  eleicao?: string;
  turno?: number;
}

export type RefUfs = Record<string, { nome: string; ibge: string | null; regiao: string }>;
export type RefMunicipios = Record<string, { tse: string; uf: string; nome: string; capital: boolean }>;

/** Município já processado localmente (líder/margem/percentuais). */
export interface MunRow {
  ibge: string;
  uf: string;
  secTotal: number;
  secTotalizadas: number;
  aptos: number;
  comparecimento: number;
  validos: number;
  brancos: number;
  nulos: number;
  v: number[];
  pct: number[];
  liderIdx: number; // -1 sem dados
  margemPct: number;
  pctApurado: number;
}
