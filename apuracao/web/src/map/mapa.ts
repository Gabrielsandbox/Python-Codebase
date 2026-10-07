// Mapa coroplético do Brasil em Canvas 2D.
//
//  - Geometrias projetadas uma única vez (Mercator) para um "espaço base" de ~1000 px
//    e guardadas como Path2D; zoom/pan é só uma matriz (barato para 5.570 municípios).
//  - Hit-test por canvas de picking (cor = índice da feição), sem geometria no clique.
//  - Três camadas: principal (preenchimentos), overlay (realce do hover) e picking (oculto).
//  - Transição Brasil ⇄ UF animada; o progresso 0..1 controla o esmaecimento dos
//    outros estados e o zoom.

import { geoPath, geoTransform, type GeoPermissibleObjects } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Store } from '../store';
import { degrauMargem, lerVar, textoSobre } from '../color';
import { reduzMovimento } from '../format';

interface Feicao {
  id: string;
  nome: string;
  uf: string; // sigla (para municípios) ou a própria sigla (UF)
  path: Path2D;
  bbox: [number, number, number, number];
  centro: [number, number];
}

export type Alvo = { tipo: 'uf'; sigla: string; nome: string } | { tipo: 'mun'; ibge: string; uf: string; nome: string };

interface Vista {
  k: number;
  x: number;
  y: number;
}

export interface MapaOpcoes {
  store: Store;
  onHover: (alvo: Alvo | null, x: number, y: number) => void;
  onTap: (alvo: Alvo, x: number, y: number) => void;
  onPronto?: () => void;
}

const BASE = 1000;
const RAD = Math.PI / 180;

/**
 * Mercator planar (sem recorte esférico do d3): independe da orientação dos anéis
 * dos polígonos do IBGE e é mais barato para 5.570 Path2D.
 */
function mercator(lon: number, lat: number): [number, number] {
  const phi = Math.max(-85, Math.min(85, lat)) * RAD;
  return [lon * RAD, -Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

function projecaoPlana(s: number, dx: number, dy: number) {
  return geoTransform({
    point(this: { stream: { point(x: number, y: number): void } }, lon: number, lat: number) {
      const [x, y] = mercator(lon, lat);
      this.stream.point((x - dx) * s, (y - dy) * s);
    },
  });
}

export class Mapa {
  readonly raiz: HTMLElement;
  private canvas: HTMLCanvasElement;
  private over: HTMLCanvasElement;
  private pick: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private pctx: CanvasRenderingContext2D;

  private w = 0;
  private h = 0;
  private dpr = 1;

  private ufs: Feicao[] = [];
  private ufPorSigla = new Map<string, Feicao>();
  private ufPorIbge = new Map<string, string>(); // "35" -> "SP"
  private muns: Feicao[] = [];
  private munsPorUf = new Map<string, Feicao[]>();
  private munPronto = false;
  private baseBox: [number, number, number, number] = [0, 0, BASE, BASE];
  private projecao = projecaoPlana(1, 0, 0);

  private vista: Vista = { k: 1, x: 0, y: 0 };
  private ufAtual: string | null = null; // estado "alvo" (destino da transição)
  private progresso = 0; // 0 = Brasil, 1 = estado
  private anim: number | null = null;

  private pickLista: Feicao[] = [];
  private pickSujo = true;
  private hover: Feicao | null = null;
  /** Realce persistente de um município (código IBGE) — "ver no mapa" / deep link. */
  private realceMun: string | null = null;
  private hatch: CanvasPattern | null = null;
  private hatchK = 0;

  private cores = { nodata: '#ddd', hatch: '#bbb', context: '#eee', border: '#fff', tie: '#ccc', ink: '#111', surface: '#fff' };

  constructor(private opts: MapaOpcoes) {
    this.raiz = document.createElement('div');
    this.raiz.className = 'map-stage';
    this.canvas = document.createElement('canvas');
    this.over = document.createElement('canvas');
    this.over.className = 'over';
    this.pick = document.createElement('canvas');
    this.pick.className = 'pick';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Mapa do Brasil colorido pelo candidato líder em cada região');
    this.raiz.append(this.canvas, this.over, this.pick);
    this.ctx = this.canvas.getContext('2d')!;
    this.octx = this.over.getContext('2d')!;
    this.pctx = this.pick.getContext('2d', { willReadFrequently: true })!;
    this.lerCores();

    new ResizeObserver(() => this.redimensionar()).observe(this.raiz);
    this.raiz.addEventListener('pointermove', (e) => this.aoMover(e));
    this.raiz.addEventListener('pointerleave', () => this.limparHover());
    this.raiz.addEventListener('click', (e) => this.aoClicar(e));
  }

  // ------------------------------------------------------------------ geometria
  setGeoUf(topo: Topology): void {
    const col = feature(topo, topo.objects.uf as GeometryCollection);
    const bruto = geoPath(projecaoPlana(1, 0, 0)).bounds(col as GeoPermissibleObjects);
    const bw = bruto[1][0] - bruto[0][0];
    const bh = bruto[1][1] - bruto[0][1];
    const s = BASE / Math.max(bw, bh);
    this.projecao = projecaoPlana(s, bruto[0][0], bruto[0][1]);
    const gp = geoPath(this.projecao);
    this.baseBox = [0, 0, bw * s, bh * s];
    const ibgeParaSigla = new Map<string, string>();
    for (const [sigla, r] of Object.entries(this.opts.store.refUfs)) if (r.ibge) ibgeParaSigla.set(r.ibge, sigla);
    this.ufs = col.features.map((f) => {
      const p = f.properties as { id: string; nome: string };
      const sigla = ibgeParaSigla.get(p.id) ?? p.id;
      return this.feicao(gp, f as GeoPermissibleObjects, p.id, p.nome, sigla);
    });
    this.ufPorSigla.clear();
    for (const f of this.ufs) {
      this.ufPorSigla.set(f.uf, f);
      this.ufPorIbge.set(f.id, f.uf);
    }
    this.ajustarVista(false);
    this.pickSujo = true;
    this.render();
    this.opts.onPronto?.();
  }

  /** Processa a malha municipal em fatias para não travar a interface. */
  setGeoMun(topo: Topology): Promise<void> {
    const col = feature(topo, topo.objects.mun as GeometryCollection);
    const gp = geoPath(this.projecao);
    const feats = col.features;
    const out: Feicao[] = [];
    const porUf = new Map<string, Feicao[]>();
    let i = 0;
    return new Promise((resolve) => {
      const fatia = () => {
        const fim = Math.min(feats.length, i + 350);
        for (; i < fim; i++) {
          const f = feats[i];
          const p = f.properties as { id: string; nome: string; uf: string };
          const fe = this.feicao(gp, f as GeoPermissibleObjects, p.id, p.nome, p.uf);
          out.push(fe);
          let arr = porUf.get(p.uf);
          if (!arr) porUf.set(p.uf, (arr = []));
          arr.push(fe);
        }
        if (i < feats.length) setTimeout(fatia, 0);
        else {
          this.muns = out;
          this.munsPorUf = porUf;
          this.munPronto = true;
          this.pickSujo = true;
          this.render();
          resolve();
        }
      };
      fatia();
    });
  }

  get temMunicipios(): boolean {
    return this.munPronto;
  }

  private feicao(gp: ReturnType<typeof geoPath>, f: GeoPermissibleObjects, id: string, nome: string, uf: string): Feicao {
    const d = gp(f) ?? '';
    const b = gp.bounds(f);
    return {
      id,
      nome,
      uf,
      path: new Path2D(d),
      bbox: [b[0][0], b[0][1], b[1][0], b[1][1]],
      centro: [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2],
    };
  }

  // ------------------------------------------------------------------ vista
  private redimensionar(): void {
    const r = this.raiz.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.w = r.width;
    this.h = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.canvas, this.over]) {
      c.width = Math.round(this.w * this.dpr);
      c.height = Math.round(this.h * this.dpr);
    }
    this.pick.width = Math.round(this.w);
    this.pick.height = Math.round(this.h);
    this.hatch = null;
    this.ajustarVista(false);
    this.pickSujo = true;
    this.render();
  }

  private vistaPara(bbox: [number, number, number, number], pad: number): Vista {
    const bw = bbox[2] - bbox[0] || 1;
    const bh = bbox[3] - bbox[1] || 1;
    const k = Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh);
    return {
      k,
      x: this.w / 2 - ((bbox[0] + bbox[2]) / 2) * k,
      y: this.h / 2 - ((bbox[1] + bbox[3]) / 2) * k,
    };
  }

  private vistaAlvo(): Vista {
    if (this.ufAtual) {
      const f = this.ufPorSigla.get(this.ufAtual);
      if (f) return this.vistaPara(f.bbox, Math.min(this.w, this.h) * 0.06);
    }
    return this.vistaPara(this.baseBox, Math.min(this.w, this.h) * 0.03);
  }

  private ajustarVista(animar: boolean): void {
    if (this.w === 0 || this.ufs.length === 0) return;
    const destino = this.vistaAlvo();
    const progAlvo = this.ufAtual ? 1 : 0;
    if (!animar || reduzMovimento()) {
      this.vista = destino;
      this.progresso = progAlvo;
      return;
    }
    const origem = { ...this.vista };
    const prog0 = this.progresso;
    const c0: [number, number] = [(this.w / 2 - origem.x) / origem.k, (this.h / 2 - origem.y) / origem.k];
    const c1: [number, number] = [(this.w / 2 - destino.x) / destino.k, (this.h / 2 - destino.y) / destino.k];
    const t0 = performance.now();
    const dur = 750;
    if (this.anim) cancelAnimationFrame(this.anim);
    const passo = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const k = origem.k * Math.pow(destino.k / origem.k, e);
      const cx = c0[0] + (c1[0] - c0[0]) * e;
      const cy = c0[1] + (c1[1] - c0[1]) * e;
      this.vista = { k, x: this.w / 2 - cx * k, y: this.h / 2 - cy * k };
      this.progresso = prog0 + (progAlvo - prog0) * e;
      this.render(p < 1);
      if (p < 1) this.anim = requestAnimationFrame(passo);
      else {
        this.anim = null;
        this.pickSujo = true;
      }
    };
    this.anim = requestAnimationFrame(passo);
  }

  /** Navega para um estado (sigla) ou volta ao Brasil (null). */
  irPara(sigla: string | null): void {
    if (sigla === this.ufAtual) return;
    // antes da malha chegar (deep link #uf=XX), guarda a sigla: setGeoUf aplica a vista.
    this.ufAtual = sigla && (this.ufs.length === 0 || this.ufPorSigla.has(sigla)) ? sigla : null;
    this.limparHover();
    this.pickSujo = true;
    this.ajustarVista(true);
  }

  // ------------------------------------------------------------------ cores
  lerCores(): void {
    this.cores = {
      nodata: lerVar('--map-nodata'),
      hatch: lerVar('--map-nodata-hatch'),
      context: lerVar('--map-context'),
      border: lerVar('--map-border'),
      tie: lerVar('--map-tie'),
      ink: lerVar('--ink'),
      surface: lerVar('--surface'),
    };
    this.hatch = null;
  }

  private corUf(sigla: string): string | CanvasPattern {
    const r = this.opts.store.resultadoUf(sigla);
    if (!r || r.secoes.totalizadas === 0 || r.votos.validos === 0) return this.padraoHatch();
    const i = r.lider ? this.opts.store.idx(r.lider) : -1;
    if (i < 0) return this.cores.nodata;
    if (r.margem_votos === 0) return this.cores.tie;
    return this.opts.store.paleta.rampas[i][degrauMargem(r.margem_pct)];
  }

  private corMun(ibge: string): string | CanvasPattern {
    const m = this.opts.store.mun?.get(ibge);
    if (!m || m.liderIdx < 0) return this.padraoHatch();
    if (m.margemPct === 0) return this.cores.tie;
    return this.opts.store.paleta.rampas[m.liderIdx][degrauMargem(m.margemPct)];
  }

  private padraoHatch(): CanvasPattern {
    const k = this.vista.k * this.dpr;
    if (this.hatch && this.hatchK === k) return this.hatch;
    const s = 8 * this.dpr;
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const x = c.getContext('2d')!;
    x.fillStyle = this.cores.nodata;
    x.fillRect(0, 0, s, s);
    x.strokeStyle = this.cores.hatch;
    x.lineWidth = 1.2 * this.dpr;
    x.beginPath();
    x.moveTo(-s / 4, s + s / 4);
    x.lineTo(s + s / 4, -s / 4);
    x.moveTo(-s / 4, s / 4);
    x.lineTo(s / 4, -s / 4);
    x.moveTo((3 * s) / 4, s + s / 4);
    x.lineTo(s + s / 4, (3 * s) / 4);
    x.stroke();
    const p = this.ctx.createPattern(c, 'repeat')!;
    p.setTransform(new DOMMatrix().scale(1 / k));
    this.hatch = p;
    this.hatchK = k;
    return p;
  }

  // ------------------------------------------------------------------ render
  render(animando = false): void {
    if (this.w === 0 || this.ufs.length === 0) return;
    const { ctx, dpr } = this;
    const { k, x, y } = this.vista;
    const store = this.opts.store;
    const p = this.progresso;
    const alvo = this.ufAtual;
    const nacionalMun = store.granularidade === 'mun' && this.munPronto && store.mun && !alvo && !animando;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    ctx.lineJoin = 'round';

    // 1. estados coloridos pelo líder (sempre; base da transição)
    if (!nacionalMun) {
      for (const f of this.ufs) {
        ctx.fillStyle = this.corUf(f.uf);
        ctx.fill(f.path);
      }
    } else {
      // visão nacional por município
      for (const f of this.muns) {
        ctx.fillStyle = this.corMun(f.id);
        ctx.fill(f.path);
      }
      ctx.strokeStyle = this.cores.border;
      ctx.lineWidth = 0.35 / k;
      ctx.globalAlpha = 0.6;
      for (const f of this.muns) ctx.stroke(f.path);
      ctx.globalAlpha = 1;
    }

    // 2. esmaece os demais estados durante/após o drill
    if (p > 0 && alvo) {
      ctx.globalAlpha = p * 0.92;
      ctx.fillStyle = this.cores.context;
      for (const f of this.ufs) if (f.uf !== alvo) ctx.fill(f.path);
      ctx.globalAlpha = 1;
    }

    // 3. municípios do estado alvo
    if (alvo) {
      const ms = this.munsPorUf.get(alvo);
      if (ms && store.mun) {
        for (const f of ms) {
          ctx.fillStyle = this.corMun(f.id);
          ctx.fill(f.path);
        }
        ctx.strokeStyle = this.cores.border;
        ctx.lineWidth = Math.min(0.9, 1.2 / k) / 1;
        ctx.lineWidth = 0.8 / k;
        for (const f of ms) ctx.stroke(f.path);
      }
    }

    // 4. fronteiras estaduais
    ctx.strokeStyle = this.cores.border;
    ctx.lineWidth = (nacionalMun ? 1.1 : 1) / k;
    for (const f of this.ufs) ctx.stroke(f.path);

    // 5. contorno do estado alvo
    if (alvo && p > 0) {
      const f = this.ufPorSigla.get(alvo);
      if (f) {
        ctx.globalAlpha = p;
        ctx.strokeStyle = this.cores.ink;
        ctx.lineWidth = 1.6 / k;
        ctx.stroke(f.path);
        ctx.globalAlpha = 1;
      }
    }

    // 6. siglas dos estados (visão nacional, só se houver espaço)
    if (!alvo && p < 0.3 && k * (this.baseBox[2] - this.baseBox[0]) > 330) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `600 ${Math.max(9.5, Math.min(12, k * 11))}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1 - p / 0.3;
      for (const f of this.ufs) {
        if (f.uf === 'DF' || f.uf === 'SE' || f.uf === 'AL' || f.uf === 'RN' || f.uf === 'PB' || f.uf === 'ES' || f.uf === 'RJ') {
          if (k * (this.baseBox[2] - this.baseBox[0]) < 520) continue;
        }
        const cor = this.corUf(f.uf);
        ctx.fillStyle = typeof cor === 'string' ? textoSobre(cor) : this.cores.ink;
        ctx.globalAlpha = (1 - p / 0.3) * (typeof cor === 'string' ? 0.9 : 0.75);
        const [cx, cy] = this.rotulo(f);
        ctx.fillText(f.uf, cx * k + x, cy * k + y);
      }
      ctx.globalAlpha = 1;
    }

    if (this.pickSujo && !animando) this.renderPick();
    this.renderOverlay();
  }

  /** Ponto do rótulo: centro do bbox, com ajustes para estados de forma irregular. */
  private rotulo(f: Feicao): [number, number] {
    const [cx, cy] = f.centro;
    const [x0, y0, x1, y1] = f.bbox;
    switch (f.uf) {
      case 'SC':
        return [cx + (x1 - x0) * 0.1, cy];
      case 'RJ':
        return [cx + (x1 - x0) * 0.15, cy - (y1 - y0) * 0.05];
      case 'BA':
        return [cx - (x1 - x0) * 0.05, cy];
      case 'MG':
        return [cx, cy + (y1 - y0) * 0.05];
      case 'PA':
        return [cx, cy + (y1 - y0) * 0.05];
      case 'AM':
        return [cx, cy];
      case 'MA':
        return [cx - (x1 - x0) * 0.05, cy + (y1 - y0) * 0.15];
      case 'PI':
        return [cx, cy];
      case 'RS':
        return [cx, cy];
      default:
        return [cx, cy];
    }
  }

  private renderPick(): void {
    const { pctx } = this;
    const { k, x, y } = this.vista;
    const lista: Feicao[] = [];
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, this.pick.width, this.pick.height);
    pctx.setTransform(k, 0, 0, k, x, y);
    const alvo = this.ufAtual;
    const store = this.opts.store;
    const pintar = (f: Feicao) => {
      const i = lista.push(f); // índice + 1
      pctx.fillStyle = `rgb(${(i >> 16) & 255},${(i >> 8) & 255},${i & 255})`;
      pctx.fill(f.path);
    };
    if (alvo) {
      for (const f of this.ufs) if (f.uf !== alvo) pintar(f);
      for (const f of this.munsPorUf.get(alvo) ?? []) pintar(f);
    } else if (store.granularidade === 'mun' && this.munPronto) {
      for (const f of this.muns) pintar(f);
    } else {
      for (const f of this.ufs) pintar(f);
    }
    this.pickLista = lista;
    this.pickSujo = false;
  }

  private renderOverlay(): void {
    const { octx, dpr } = this;
    const { k, x, y } = this.vista;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, this.over.width, this.over.height);
    const realce = this.realceMun && this.ufAtual ? this.muns.find((f) => f.id === this.realceMun) ?? null : null;
    if (!this.hover && !realce) return;
    octx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    octx.lineJoin = 'round';
    for (const f of [realce, this.hover]) {
      if (!f) continue;
      octx.strokeStyle = this.cores.surface;
      octx.lineWidth = (f === realce ? 5 : 3.5) / k;
      octx.stroke(f.path);
      octx.strokeStyle = this.cores.ink;
      octx.lineWidth = (f === realce ? 2.2 : 1.5) / k;
      octx.stroke(f.path);
    }
  }

  // ------------------------------------------------------------------ interação
  private feicaoEm(e: PointerEvent | MouseEvent): Feicao | null {
    if (this.pickSujo) this.renderPick();
    const r = this.raiz.getBoundingClientRect();
    const px = Math.floor(e.clientX - r.left);
    const py = Math.floor(e.clientY - r.top);
    if (px < 0 || py < 0 || px >= this.pick.width || py >= this.pick.height) return null;
    const d = this.pctx.getImageData(px, py, 1, 1).data;
    if (d[3] < 200) return null;
    const i = (d[0] << 16) | (d[1] << 8) | d[2];
    return this.pickLista[i - 1] ?? null;
  }

  private alvoDe(f: Feicao): Alvo {
    if (f.id.length === 2) return { tipo: 'uf', sigla: f.uf, nome: f.nome };
    return { tipo: 'mun', ibge: f.id, uf: f.uf, nome: f.nome };
  }

  private aoMover(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' || this.anim) return;
    const f = this.feicaoEm(e);
    const r = this.raiz.getBoundingClientRect();
    if (f !== this.hover) {
      this.hover = f;
      this.renderOverlay();
      this.raiz.style.cursor = f ? 'pointer' : '';
    }
    this.opts.onHover(f ? this.alvoDe(f) : null, e.clientX - r.left, e.clientY - r.top);
  }

  private limparHover(): void {
    if (this.hover) {
      this.hover = null;
      this.renderOverlay();
    }
    this.raiz.style.cursor = '';
    this.opts.onHover(null, 0, 0);
  }

  private aoClicar(e: MouseEvent): void {
    if (this.anim) return;
    const f = this.feicaoEm(e);
    if (!f) return;
    const r = this.raiz.getBoundingClientRect();
    this.opts.onTap(this.alvoDe(f), e.clientX - r.left, e.clientY - r.top);
  }

  /** Realça (ou limpa) uma UF por sigla — usado pelo hover da tabela. */
  realcarUf(sigla: string | null): void {
    const f = sigla ? this.ufPorSigla.get(sigla) ?? null : null;
    if (f === this.hover) return;
    this.hover = f;
    this.renderOverlay();
  }

  /** Realça um município (IBGE) de forma persistente enquanto o estado dele está aberto. */
  realcarMun(ibge: string | null): void {
    this.realceMun = ibge;
    this.renderOverlay();
  }

  invalidarPick(): void {
    this.pickSujo = true;
  }
}
