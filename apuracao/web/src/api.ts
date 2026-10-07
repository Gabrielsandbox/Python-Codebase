// Leitura dos snapshots estáticos + polling com pausa quando a aba está oculta.

import type { Ativo, Br, Meta, Mun, Status, Timeline, Uf } from './types';

export const DADOS_BASE: string = (import.meta.env.VITE_DADOS_BASE as string | undefined)?.replace(/\/$/, '') || '/dados';

export class HttpError extends Error {
  constructor(public status: number, public url: string) {
    super(`HTTP ${status} em ${url}`);
  }
}

/** Busca JSON revalidando no servidor/CDN (ETag / If-None-Match). */
export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache', signal, headers: { Accept: 'application/json' } });
  if (!r.ok) throw new HttpError(r.status, url);
  return (await r.json()) as T;
}

export interface Fontes {
  ativo: Ativo;
  prefixo: string; // URL absoluta/base do snapshot ativo (sem barra final)
}

export async function descobrirAtivo(): Promise<Fontes> {
  const ativo = await getJson<Ativo>(`${DADOS_BASE}/ativo.json`);
  const prefixo = `${DADOS_BASE}/${ativo.prefixo.replace(/^\/|\/$/g, '')}`;
  return { ativo, prefixo };
}

export const urls = (prefixo: string) => ({
  meta: `${prefixo}/meta.json`,
  br: `${prefixo}/br.json`,
  uf: `${prefixo}/uf.json`,
  mun: `${prefixo}/mun.json`,
  status: `${prefixo}/status.json`,
  timeline: `${prefixo}/timeline/br.json`,
});

export type Chave = 'br' | 'uf' | 'mun' | 'status' | 'timeline';
export interface Payloads {
  br: Br;
  uf: Uf;
  mun: Mun;
  status: Status;
  timeline: Timeline;
  meta: Meta;
}

export const INTERVALOS: Record<Chave, number> = {
  br: 10_000,
  uf: 10_000,
  status: 10_000,
  mun: 60_000,
  timeline: 30_000,
};

interface Tarefa {
  chave: Chave;
  url: string;
  intervalo: number;
  timer: number | null;
  emVoo: boolean;
  ultimoTexto: string | null;
  proximo: number | null; // instante (ms) da próxima verificação agendada
}

/** Resumo de uma verificação concluída (com ou sem mudança, com ou sem erro). */
export interface Ciclo {
  chave: Chave;
  /** Instante (ms) em que a verificação terminou. */
  em: number;
  /** Instante (ms) da próxima verificação agendada (null se o polling está pausado). */
  proximo: number | null;
  /** O conteúdo mudou em relação à verificação anterior? */
  mudou: boolean;
  /** A requisição teve sucesso? */
  ok: boolean;
  intervalo: number;
}

/**
 * Agenda o polling de cada arquivo. `onDados` só é chamado quando o conteúdo mudou
 * (comparação textual — barato e independente de ETag).
 */
export class Poller {
  private tarefas: Tarefa[] = [];
  private ativo = true;
  private onErro?: (e: unknown, chave: Chave) => void;
  private ouvintesCiclo = new Set<(c: Ciclo) => void>();

  constructor(
    private onDados: <K extends Chave>(chave: K, dados: Payloads[K]) => void,
    onErro?: (e: unknown, chave: Chave) => void,
  ) {
    this.onErro = onErro;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.pausar();
      else this.retomar();
    });
    window.addEventListener('online', () => this.retomar());
  }

  registrar(chave: Chave, url: string, intervalo = INTERVALOS[chave]): void {
    const t: Tarefa = { chave, url, intervalo, timer: null, emVoo: false, ultimoTexto: null, proximo: null };
    this.tarefas.push(t);
    void this.executar(t);
  }

  /** Avisa ao fim de cada verificação (para indicadores de "ao vivo"). Devolve o cancelamento. */
  onCiclo(cb: (c: Ciclo) => void): () => void {
    this.ouvintesCiclo.add(cb);
    return () => this.ouvintesCiclo.delete(cb);
  }

  /** Instante (ms) da próxima verificação de `chave`, ou null se desconhecido/pausado. */
  proximo(chave: Chave): number | null {
    return this.tarefas.find((t) => t.chave === chave)?.proximo ?? null;
  }

  get pausado(): boolean {
    return !this.ativo;
  }

  /** Força uma rodada imediata de todas as tarefas. */
  agora(): void {
    for (const t of this.tarefas) {
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = null;
      }
      void this.executar(t);
    }
  }

  private pausar(): void {
    this.ativo = false;
    for (const t of this.tarefas) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.proximo = null;
    }
  }

  private retomar(): void {
    if (this.ativo) return;
    this.ativo = true;
    this.agora();
  }

  private agendar(t: Tarefa): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.proximo = null;
    if (!this.ativo) return;
    t.proximo = Date.now() + t.intervalo;
    t.timer = window.setTimeout(() => void this.executar(t), t.intervalo);
  }

  private async executar(t: Tarefa): Promise<void> {
    if (t.emVoo) return;
    t.emVoo = true;
    let mudou = false;
    let ok = false;
    try {
      const r = await fetch(t.url, { cache: 'no-cache', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new HttpError(r.status, t.url);
      const texto = await r.text();
      ok = true;
      if (texto !== t.ultimoTexto) {
        mudou = t.ultimoTexto !== null; // a 1ª carga não conta como "novos dados"
        t.ultimoTexto = texto;
        this.onDados(t.chave, JSON.parse(texto));
      }
    } catch (e) {
      this.onErro?.(e, t.chave);
    } finally {
      t.emVoo = false;
      this.agendar(t);
      const c: Ciclo = { chave: t.chave, em: Date.now(), proximo: t.proximo, mudou, ok, intervalo: t.intervalo };
      this.ouvintesCiclo.forEach((cb) => cb(c));
    }
  }
}
