// Estado da aplicação + dados derivados (líder/margem por município, ordem dos
// candidatos, paleta) e um emissor de eventos minimalista.

import { modoEscuro, montarPaleta, type Paleta } from './color';
import type { Br, Caminho, Meta, Mun, MunRow, RefMunicipios, RefUfs, Resultado, Ritmo, Status, Timeline, Uf } from './types';

export type Granularidade = 'uf' | 'mun';

export type Evento = 'meta' | 'br' | 'uf' | 'mun' | 'status' | 'timeline' | 'caminho' | 'ritmo' | 'selecao' | 'granularidade' | 'tema' | 'ref';

type Ouvinte = () => void;

export class Store {
  meta!: Meta;
  br: Br | null = null;
  uf: Uf | null = null;
  status: Status | null = null;
  timeline: Timeline | null = null;
  caminho: Caminho | null = null;
  ritmo: Ritmo | null = null;
  mun: Map<string, MunRow> | null = null;
  munPorUf: Map<string, MunRow[]> = new Map();
  refUfs: RefUfs = {};
  refMun: RefMunicipios | null = null;
  paleta!: Paleta;
  /** Índices (na ordem de meta.cands) dos candidatos em destaque, estável durante a noite. */
  principais: number[] = [];
  ufSelecionada: string | null = null;
  granularidade: Granularidade = 'uf';
  /** Instante (ms) em que cada arquivo mudou pela última vez — para o "pulso". */
  mudouEm: Partial<Record<Evento, number>> = {};

  private ouvintes = new Map<Evento, Set<Ouvinte>>();

  constructor() {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.atualizarTema());
  }

  on(ev: Evento | Evento[], cb: Ouvinte): () => void {
    const evs = Array.isArray(ev) ? ev : [ev];
    for (const e of evs) {
      if (!this.ouvintes.has(e)) this.ouvintes.set(e, new Set());
      this.ouvintes.get(e)!.add(cb);
    }
    return () => evs.forEach((e) => this.ouvintes.get(e)?.delete(cb));
  }

  private emitir(ev: Evento): void {
    this.mudouEm[ev] = Date.now();
    this.ouvintes.get(ev)?.forEach((cb) => cb());
  }

  // ------------------------------------------------------------- entrada de dados
  setMeta(meta: Meta): void {
    this.meta = meta;
    this.paleta = montarPaleta(meta.cands.map((id) => meta.candidatos[id]?.cor ?? '#888888'), modoEscuro());
    if (meta.cands.length <= 2) this.principais = meta.cands.map((_, i) => i);
    this.emitir('meta');
  }

  atualizarTema(): void {
    this.paleta = montarPaleta(this.meta.cands.map((id) => this.meta.candidatos[id]?.cor ?? '#888888'), modoEscuro());
    this.emitir('tema');
  }

  setBr(br: Br): void {
    this.br = this.alinharResultado(br, br.cands) as Br;
    if (this.principais.length === 0) {
      // 1ª carga: os dois mais votados ficam fixos como "principais" (não trocam de lado).
      this.principais = this.br.v
        .map((v, i) => [v, i] as const)
        .sort((a, b) => b[0] - a[0])
        .slice(0, 2)
        .map(([, i]) => i);
    }
    this.emitir('br');
  }

  setUf(uf: Uf): void {
    const mapa = this.mapaIndices(uf.cands);
    if (mapa) for (const k of Object.keys(uf.ufs)) uf.ufs[k] = this.alinharResultado(uf.ufs[k], uf.cands, mapa);
    this.uf = uf;
    this.emitir('uf');
  }

  setStatus(s: Status): void {
    this.status = s;
    this.emitir('status');
  }

  setTimeline(t: Timeline): void {
    const mapa = this.mapaIndices(t.cands);
    if (mapa) {
      for (const p of t.pontos) {
        p.v = this.reordenar(p.v, mapa);
        p.pct = this.reordenar(p.pct, mapa);
      }
    }
    this.timeline = t;
    this.emitir('timeline');
  }

  setCaminho(c: Caminho): void {
    this.caminho = c;
    this.emitir('caminho');
  }

  setRitmo(r: Ritmo): void {
    this.ritmo = r;
    this.emitir('ritmo');
  }

  setMun(m: Mun): void {
    const mapa = this.mapaIndices(m.cands);
    const n = this.meta.cands.length;
    const rows = new Map<string, MunRow>();
    const porUf = new Map<string, MunRow[]>();
    for (const l of m.linhas) {
      const [ibge, uf, secTotal, secTotalizadas, aptos, comparecimento, validos, brancos, nulos, v0] = l;
      if (!ibge || uf === 'ZZ' || ibge.startsWith('99')) continue; // exterior: fora do mapa
      const v = mapa ? this.reordenar(v0, mapa) : v0;
      const pct = new Array<number>(n);
      let liderIdx = -1;
      let l1 = -1;
      let l2 = -1;
      for (let i = 0; i < n; i++) {
        const vi = v[i] ?? 0;
        pct[i] = validos > 0 ? (vi / validos) * 100 : 0;
        if (vi > l1) {
          l2 = l1;
          l1 = vi;
          liderIdx = i;
        } else if (vi > l2) l2 = vi;
      }
      if (secTotalizadas === 0 || validos === 0) liderIdx = -1;
      const margemPct = liderIdx >= 0 && validos > 0 ? ((l1 - Math.max(l2, 0)) / validos) * 100 : 0;
      const row: MunRow = {
        ibge,
        uf,
        secTotal,
        secTotalizadas,
        aptos,
        comparecimento,
        validos,
        brancos,
        nulos,
        v,
        pct,
        liderIdx,
        margemPct,
        pctApurado: secTotal > 0 ? (secTotalizadas / secTotal) * 100 : 0,
      };
      rows.set(ibge, row);
      let arr = porUf.get(uf);
      if (!arr) porUf.set(uf, (arr = []));
      arr.push(row);
    }
    this.mun = rows;
    this.munPorUf = porUf;
    this.emitir('mun');
  }

  setRef(ufs: RefUfs, mun: RefMunicipios | null): void {
    this.refUfs = ufs;
    this.refMun = mun;
    this.emitir('ref');
  }

  // ------------------------------------------------------------- interação
  selecionarUf(sigla: string | null): void {
    if (sigla === this.ufSelecionada) return;
    this.ufSelecionada = sigla;
    this.emitir('selecao');
  }

  setGranularidade(g: Granularidade): void {
    if (g === this.granularidade) return;
    this.granularidade = g;
    this.emitir('granularidade');
  }

  // ------------------------------------------------------------- utilidades
  /** Mapa de índices quando a ordem `cands` de um arquivo difere da do meta.json. */
  private mapaIndices(cands: string[] | undefined): number[] | null {
    if (!cands) return null;
    const ref = this.meta.cands;
    if (cands.length === ref.length && cands.every((c, i) => c === ref[i])) return null;
    return ref.map((id) => cands.indexOf(id));
  }

  private reordenar<T>(arr: T[], mapa: number[]): T[] {
    return mapa.map((i) => (i >= 0 ? arr[i] : (0 as unknown as T)));
  }

  private alinharResultado<T extends Resultado>(r: T, cands: string[] | undefined, mapa = this.mapaIndices(cands)): T {
    if (!mapa) return r;
    return { ...r, v: this.reordenar(r.v, mapa), pct: this.reordenar(r.pct, mapa) };
  }

  idx(id: string): number {
    return this.meta.cands.indexOf(id);
  }

  cand(i: number) {
    return this.meta.candidatos[this.meta.cands[i]];
  }

  /** Índices de candidatos ordenados por votos no resultado dado. */
  ordenarPorVotos(r: { v: number[] }): number[] {
    return r.v.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  }

  resultadoUf(sigla: string) {
    return this.uf?.ufs[sigla] ?? null;
  }

  nomeUf(sigla: string): string {
    return this.uf?.ufs[sigla]?.nome ?? this.refUfs[sigla]?.nome ?? sigla;
  }

  nomeMun(ibge: string, fallback?: string): string {
    return this.refMun?.[ibge]?.nome ?? fallback ?? ibge;
  }

  get disputaDupla(): boolean {
    return this.meta.cands.length === 2;
  }
}
