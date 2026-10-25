// Cliente da API do acervo (apuracao/api: /api/v1/acervo/*).
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api';

export interface Estado {
  candidatos: number[];
  votacao: number[];
  detalhe: number[];
  pesquisas: Array<{ ano: number; cargo: number; uf: string; pontos: number; de: string; ate: string }>;
  cargos: Record<string, string>;
}
export interface Candidatura {
  ano: number;
  turno: number;
  sq_candidato: string;
  nm_urna_candidato: string;
  nm_candidato: string;
  nr_candidato: number | null;
  sg_partido: string | null;
  nm_partido?: string | null;
  cd_cargo: number;
  ds_cargo: string;
  sg_uf: string;
  sg_ue?: string;
  nm_ue?: string | null;
  ds_sit_tot_turno: string | null;
  ds_situacao_candidatura: string | null;
  nm_coligacao?: string | null;
  ds_composicao_coligacao?: string | null;
  st_reeleicao?: string | null;
  votos: number | null;
}
export interface Pessoa {
  perfil: {
    nm_candidato: string;
    nm_urna_candidato: string;
    nm_social_candidato: string | null;
    dt_nascimento: string | null;
    ds_genero: string | null;
    ds_grau_instrucao: string | null;
    ds_ocupacao: string | null;
    ds_cor_raca: string | null;
    sg_uf_nascimento: string | null;
    nm_municipio_nascimento: string | null;
  };
  resumo: { candidaturas: number; eleicoes_vencidas: number; partidos: string[]; primeiro_ano: number | null; ultimo_ano: number | null };
  candidaturas: Candidatura[];
}
export interface LinhaEleicao {
  sq_candidato: string;
  nm_urna_candidato: string;
  nr_candidato: number | null;
  sg_partido: string | null;
  ds_sit_tot_turno: string | null;
  votos: number;
  pct: number | null;
}
export interface Eleicao {
  ano: number;
  cargo: number;
  cargo_nome: string;
  turno: number;
  uf: string | null;
  candidatos: LinhaEleicao[];
  totais: { aptos: number; comparecimento: number; abstencoes: number; brancos: number; nulos: number; validos_nominais: number } | null;
}
export interface LinhaUf {
  sg_uf: string;
  sq_candidato: string;
  nome: string;
  partido: string | null;
  votos: number;
  total: number;
  pos: number;
}
export interface PontoPesquisa {
  instituto: string;
  data_divulgacao: string;
  data_fim: string | null;
  turno: number | null;
  cenario: string | null;
  candidato: string;
  partido: string | null;
  percentual: number;
  amostra: number | null;
  margem: number | null;
  registro_tse: string | null;
  fonte_url: string | null;
}

async function get<T>(caminho: string): Promise<T> {
  const r = await fetch(`${API_BASE}${caminho}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}
const qs = (o: Record<string, string | number | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

export const estado = () => get<Estado>('/v1/acervo/estado');
export const buscar = (q: string, f: { ano?: number; cargo?: number; uf?: string } = {}) =>
  get<{ itens: Candidatura[] }>(`/v1/acervo/candidatos?${qs({ q, ...f })}`);
export const pessoa = (sq: string, ano: number) => get<Pessoa>(`/v1/acervo/candidato?${qs({ sq, ano })}`);
export const eleicao = (ano: number, cargo: number, turno: number, uf?: string, limite = 200) =>
  get<Eleicao>(`/v1/acervo/eleicao?${qs({ ano, cargo, turno, uf, limite })}`);
export const eleicaoUfs = (ano: number, cargo: number, turno: number) =>
  get<{ itens: LinhaUf[] }>(`/v1/acervo/eleicao/ufs?${qs({ ano, cargo, turno })}`);
export const pesquisas = (ano: number, cargo: number, uf: string, turno?: number) =>
  get<{ pontos: PontoPesquisa[] }>(`/v1/acervo/pesquisas?${qs({ ano, cargo, uf, turno })}`);
export const cores = async (): Promise<Record<string, string>> => {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}ref/cores.json`);
    return (await r.json()) as Record<string, string>;
  } catch {
    return {};
  }
};
