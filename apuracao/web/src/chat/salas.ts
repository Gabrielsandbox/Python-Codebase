// Salas por estado (docs/CHAT.md › Extensões): seletor no cabeçalho do chat, contagem
// de online por sala (/chat/estado a cada 10 s), última sala em localStorage e sugestão
// a partir do deep link `#uf=XX`.

import { el, fmtInt } from '../format';
import { estado as lerEstado } from './client';

export const SALA_GERAL = 'geral';
export const CHAVE_SALA = 'chat_sala';
const INTERVALO_SALAS_MS = 10_000;

/** UFs na ordem do seletor (agrupadas por região) + exterior. */
export const UFS: readonly string[] = [
  'AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO', // Norte
  'AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE', // Nordeste
  'DF', 'GO', 'MS', 'MT', // Centro-Oeste
  'ES', 'MG', 'RJ', 'SP', // Sudeste
  'PR', 'RS', 'SC', // Sul
  'ZZ', // Exterior
];

const NOMES: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco',
  PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul',
  SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins', ZZ: 'Exterior',
};

export const salaValida = (s: string): boolean => s === SALA_GERAL || UFS.includes(s);

/** Nome legível da sala: "Geral", "São Paulo", "Exterior". */
export function nomeSala(sala: string, nomeUf?: (sigla: string) => string | undefined): string {
  if (sala === SALA_GERAL) return 'Geral';
  return nomeUf?.(sala) ?? NOMES[sala] ?? sala;
}

export function lerSalaGuardada(): string {
  try {
    const s = localStorage.getItem(CHAVE_SALA);
    return s && salaValida(s) ? s : SALA_GERAL;
  } catch {
    return SALA_GERAL;
  }
}

export function guardarSala(sala: string): void {
  try {
    localStorage.setItem(CHAVE_SALA, sala);
  } catch {
    /* sem armazenamento */
  }
}

/** UF do deep link `#uf=SP` (ou `#uf=sp`), se houver. */
export function ufDoHash(): string | null {
  const m = /(?:^#|[#&])uf=([a-zA-Z]{2})(?:&|$)/.exec(location.hash);
  if (!m) return null;
  const uf = m[1].toUpperCase();
  return UFS.includes(uf) ? uf : null;
}

export interface SeletorSalas {
  raiz: HTMLSelectElement;
  /** Sala atualmente marcada. */
  readonly sala: string;
  setSala(sala: string): void;
  /** Atualiza as contagens de online nas opções. */
  setSalas(salas: Record<string, number> | undefined): void;
  /** Começa/para o polling de /chat/estado para as contagens. */
  ligar(): void;
  desligar(): void;
}

export interface SeletorOpts {
  salaInicial: string;
  aoTrocar: (sala: string) => void;
  nomeUf?: (sigla: string) => string | undefined;
}

export function montarSeletorSalas(opts: SeletorOpts): SeletorSalas {
  const sel = el('select', { class: 'chat-salas', 'aria-label': 'Sala do chat', title: 'Trocar de sala' });
  const opcoes = new Map<string, HTMLOptionElement>();
  const rotulo = (sala: string, n: number | undefined) => {
    const nome = sala === SALA_GERAL ? 'Geral' : `${sala} · ${nomeSala(sala, opts.nomeUf)}`;
    return n ? `${nome} · ${fmtInt(n)}` : nome;
  };
  const geral = el('option', { value: SALA_GERAL, text: rotulo(SALA_GERAL, undefined) });
  opcoes.set(SALA_GERAL, geral);
  sel.append(geral);
  const grupo = el('optgroup', { label: 'Por estado' });
  for (const uf of UFS) {
    const o = el('option', { value: uf, text: rotulo(uf, undefined) });
    opcoes.set(uf, o);
    grupo.append(o);
  }
  sel.append(grupo);

  let atual = salaValida(opts.salaInicial) ? opts.salaInicial : SALA_GERAL;
  let ultimas: Record<string, number> | undefined;
  sel.value = atual;

  sel.addEventListener('change', () => {
    const nova = sel.value;
    if (!salaValida(nova) || nova === atual) return;
    atual = nova;
    guardarSala(nova);
    opts.aoTrocar(nova);
  });

  let timer: number | null = null;
  const atualizar = async () => {
    try {
      const e = await lerEstado();
      seletor.setSalas(e.salas);
    } catch {
      /* contagens são decorativas */
    }
  };

  const seletor: SeletorSalas = {
    raiz: sel,
    get sala() {
      return atual;
    },
    setSala(sala) {
      if (!salaValida(sala)) sala = SALA_GERAL;
      atual = sala;
      sel.value = sala;
      guardarSala(sala);
    },
    setSalas(salas) {
      ultimas = salas;
      for (const [sala, o] of opcoes) o.textContent = rotulo(sala, salas?.[sala]);
    },
    ligar() {
      if (timer) return;
      void atualizar();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void atualizar();
      }, INTERVALO_SALAS_MS);
    },
    desligar() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  // nomes das UFs podem chegar depois (ref/ufs.json): re-rotula sob demanda
  if (opts.nomeUf) queueMicrotask(() => seletor.setSalas(ultimas));
  return seletor;
}
