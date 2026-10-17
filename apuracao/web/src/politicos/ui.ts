// Peças compartilhadas pela busca e pela ficha: número em casas de urna, avatar, rótulos.

import { el, iniciais } from '../format';
import type { ItemIndice, Situacao } from './dados';

export const UFS: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará',
  DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná',
  PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo',
  SE: 'Sergipe', TO: 'Tocantins',
};

/** Casas por cargo, como na urna: presidente e governador 2, senador 3, federal 4, estadual 5. */
export const CASAS: Record<string, number> = { '1': 2, '3': 2, '5': 3, '6': 4, '7': 5, '8': 5 };

export const SITUACAO: Record<Situacao, string> = {
  eleito: 'Eleito',
  '2turno': 'No 2º turno',
  nao_eleito: 'Não eleito',
  suplente: 'Suplente',
  '': 'Sem resultado',
};

/** "12345" em casas de urna. Casas vazias à direita quando o número é mais curto. */
export function urnaNumero(numero: string, casas = numero.length, tamanho: 'p' | 'm' | 'g' = 'm'): HTMLElement {
  const box = el('span', { class: `urna urna--${tamanho}`, role: 'img', 'aria-label': numero ? `número ${numero}` : 'sem número' });
  for (let i = 0; i < Math.max(casas, numero.length); i++) {
    box.append(el('span', { class: numero[i] ? 'urna-casa' : 'urna-casa urna-casa--vazia', 'aria-hidden': 'true' }, numero[i] ?? ''));
  }
  return box;
}

export function avatar(nome: string, foto: string | null | undefined, classe = 'avatar'): HTMLElement {
  const box = el('span', { class: classe, 'aria-hidden': 'true' }, el('span', { class: 'avatar-ini' }, iniciais(nome)));
  if (foto) {
    const img = el('img', { src: foto, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => box.classList.add('avatar--foto'));
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

/** "Governador", "Deputado federal" etc. com a UF por extenso quando faz sentido. */
export function cargoComUf(cargoNome: string, uf: string): string {
  if (!uf || uf === 'BR') return cargoNome;
  return `${cargoNome}, ${UFS[uf] ?? uf}`;
}

export function rotuloMandato(it: ItemIndice): string | null {
  if (it.mandato === 'd') return 'Na Câmara';
  if (it.mandato === 's') return 'No Senado';
  return null;
}

// ------------------------------------------------------------------ formatação

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const brlCompacto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
const mesAno = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const fmtReais = (n: number): string => brl.format(n);
export const fmtReaisCurto = (n: number): string => (n >= 100_000 ? brlCompacto.format(n) : brl.format(n));
export const fmtPorcento = (n: number): string => pct.format(n);
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** "2026-10-14" → "14 out 2026" (curto o bastante para não quebrar na coluna de datas). */
export function fmtDia(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${Number(d)} ${MESES[Number(m) - 1]} ${a}`;
}
export const fmtMesAno = (iso: string): string => mesAno.format(new Date(iso.slice(0, 10) + 'T00:00:00Z'));
