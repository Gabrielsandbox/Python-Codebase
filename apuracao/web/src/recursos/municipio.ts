// "Meu município" (docs/RECURSOS.md §3): busca com autocompletar (sem acentos), geolocalização
// (permissão só ao tocar no botão; centróide mais próximo via d3-geo), card com o resultado,
// comparação com o Brasil, "ver no mapa", compartilhar (imagem 1080×1080 / WhatsApp) e link.

import { geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import { corCandidato, textoSobre } from '../color';
import { el, fmtInt, fmtPct, fmtPP, iniciais, nomeProprio } from '../format';
import type { Store } from '../store';
import type { SecaoMapa } from '../ui/secaoMapa';
import type { MunRow } from '../types';
import { linkFonte, urlFonteMun } from './fonte';

export interface MunicipioApi {
  /** Abre o card do município (IBGE); com `rolar`, leva a página até ele. */
  abrir(ibge: string, opts?: { rolar?: boolean; mapa?: boolean }): void;
  /** Elemento do card (para o deep link rolar até ele). */
  raiz: HTMLElement;
}

interface Entrada {
  ibge: string;
  nome: string;
  uf: string;
  chave: string; // nome normalizado, sem acentos, minúsculo
  capital: boolean;
}

const normalizar = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const urlBase = (): string => `${location.origin}${location.pathname}${location.search}`;

export function montarMunicipio(side: HTMLElement, store: Store, secao: SecaoMapa, topoMun: () => Promise<Topology>): MunicipioApi {
  // ------------------------------------------------------------- busca
  const input = el('input', {
    type: 'search',
    class: 'mun-input',
    placeholder: 'Nome do município',
    'aria-label': 'Buscar município',
    autocomplete: 'off',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
    'aria-controls': 'mun-sugestoes',
    enterkeyhint: 'search',
  });
  const sugestoes = el('ul', { class: 'mun-sug', id: 'mun-sugestoes', role: 'listbox', hidden: true });
  const geoBtn = el('button', { class: 'btn mun-geo', type: 'button' }, el('i', { class: 'ico', 'aria-hidden': 'true' }), el('span', { text: 'Usar minha localização' }));
  const aviso = el('div', { class: 'mun-aviso', role: 'status', hidden: true });
  const resultado = el('div', { class: 'mun-res' });
  const toast = el('div', { class: 'mun-toast', role: 'status', hidden: true });

  const raiz = el(
    'div',
    { class: 'card mun-card', id: 'meu-municipio' },
    el('div', { class: 'head' }, el('h2', { text: 'Meu município' }), el('span', { class: 'sub', text: 'busque ou use sua localização' })),
    el('div', { class: 'mun-busca' }, el('div', { class: 'mun-field' }, input, sugestoes), geoBtn),
    aviso,
    resultado,
    toast,
  );
  side.append(raiz);

  let indice: Entrada[] = [];
  let ativo = -1;
  let visiveis: Entrada[] = [];
  let aberto: string | null = null;
  let timerToast: number | null = null;

  const montarIndice = () => {
    if (!store.refMun) return;
    indice = Object.entries(store.refMun)
      .filter(([ibge]) => !ibge.startsWith('99'))
      .map(([ibge, r]) => ({ ibge, nome: r.nome, uf: r.uf, chave: normalizar(r.nome), capital: r.capital }));
    input.disabled = false;
    input.placeholder = 'Nome do município';
  };
  input.disabled = true;
  input.placeholder = 'Carregando municípios…';

  const avisar = (msg: string | null) => {
    aviso.hidden = !msg;
    aviso.textContent = msg ?? '';
  };

  const mostrarToast = (msg: string) => {
    toast.textContent = msg;
    toast.hidden = false;
    if (timerToast) clearTimeout(timerToast);
    timerToast = window.setTimeout(() => (toast.hidden = true), 2200);
  };

  const buscar = (q: string): Entrada[] => {
    const k = normalizar(q);
    if (k.length < 2) return [];
    // "nome - uf" / "nome uf"
    const m = /^(.*?)[\s,-]+([a-z]{2})$/.exec(k);
    const ufFiltro = m && store.refUfs[m[2].toUpperCase()] ? m[2].toUpperCase() : null;
    const termo = ufFiltro && m ? m[1].trim() : k;
    const pontuar = (e: Entrada): number => {
      if (ufFiltro && e.uf !== ufFiltro) return -1;
      if (e.chave === termo) return 4;
      if (e.chave.startsWith(termo)) return 3;
      if (e.chave.split(' ').some((w) => w.startsWith(termo))) return 2;
      if (e.chave.includes(termo)) return 1;
      return -1;
    };
    const out: { e: Entrada; p: number }[] = [];
    for (const e of indice) {
      const p = pontuar(e);
      if (p >= 0) out.push({ e, p });
    }
    out.sort((a, b) => b.p - a.p || Number(b.e.capital) - Number(a.e.capital) || a.e.nome.localeCompare(b.e.nome, 'pt-BR'));
    return out.slice(0, 8).map((x) => x.e);
  };

  const fecharSugestoes = () => {
    sugestoes.hidden = true;
    sugestoes.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    visiveis = [];
    ativo = -1;
  };

  const renderSugestoes = () => {
    visiveis = buscar(input.value);
    if (!visiveis.length) {
      fecharSugestoes();
      return;
    }
    ativo = -1;
    sugestoes.replaceChildren(
      ...visiveis.map((e, i) => {
        const li = el('li', { role: 'option', id: `mun-op-${i}`, 'aria-selected': 'false' }, el('span', { class: 'n', text: e.nome }), el('span', { class: 'u', text: e.uf }));
        li.addEventListener('pointerdown', (ev) => ev.preventDefault()); // mantém o foco no input
        li.addEventListener('click', () => escolher(e));
        return li;
      }),
    );
    sugestoes.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const marcarAtivo = (i: number) => {
    ativo = i;
    sugestoes.querySelectorAll('li').forEach((li, j) => li.setAttribute('aria-selected', String(j === i)));
    if (i >= 0) input.setAttribute('aria-activedescendant', `mun-op-${i}`);
  };

  const escolher = (e: Entrada) => {
    input.value = `${e.nome} - ${e.uf}`;
    fecharSugestoes();
    abrir(e.ibge, { rolar: false, mapa: false });
  };

  input.addEventListener('input', renderSugestoes);
  input.addEventListener('focus', () => input.value && renderSugestoes());
  input.addEventListener('blur', () => setTimeout(fecharSugestoes, 120));
  input.addEventListener('keydown', (ev) => {
    if (sugestoes.hidden && (ev.key === 'ArrowDown' || ev.key === 'Enter')) renderSugestoes();
    if (!visiveis.length) return;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      marcarAtivo((ativo + 1) % visiveis.length);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      marcarAtivo((ativo - 1 + visiveis.length) % visiveis.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      escolher(visiveis[Math.max(0, ativo)]);
    } else if (ev.key === 'Escape') fecharSugestoes();
  });

  // ------------------------------------------------------------- geolocalização
  let centroides: { ibge: string; lon: number; lat: number }[] | null = null;
  const carregarCentroides = async () => {
    if (centroides) return centroides;
    const topo = await topoMun();
    const col = feature(topo, topo.objects.mun as GeometryCollection);
    centroides = col.features.map((f) => {
      const [lon, lat] = geoCentroid(f as never);
      return { ibge: (f.properties as { id: string }).id, lon, lat };
    });
    return centroides;
  };

  const maisProximo = (lon: number, lat: number): string | null => {
    if (!centroides) return null;
    const cl = Math.cos((lat * Math.PI) / 180);
    let melhor: string | null = null;
    let d = Infinity;
    for (const c of centroides) {
      const dx = (c.lon - lon) * cl;
      const dy = c.lat - lat;
      const dd = dx * dx + dy * dy;
      if (dd < d) {
        d = dd;
        melhor = c.ibge;
      }
    }
    return melhor;
  };

  geoBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      avisar('Seu navegador não oferece localização. Busque pelo nome.');
      return;
    }
    geoBtn.disabled = true;
    geoBtn.classList.add('busy');
    avisar(null);
    const fim = () => {
      geoBtn.disabled = false;
      geoBtn.classList.remove('busy');
    };
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await carregarCentroides();
          const ibge = maisProximo(pos.coords.longitude, pos.coords.latitude);
          if (!ibge) throw new Error('sem malha');
          const ref = store.refMun?.[ibge];
          if (ref) input.value = `${ref.nome} - ${ref.uf}`;
          abrir(ibge, { rolar: false, mapa: false });
        } catch (e) {
          console.warn(e);
          avisar('Não foi possível localizar seu município. Busque pelo nome.');
        } finally {
          fim();
        }
      },
      (err) => {
        fim();
        avisar(err.code === err.PERMISSION_DENIED ? 'Permissão de localização negada. Busque pelo nome.' : 'Não foi possível obter sua localização. Busque pelo nome.');
      },
      { timeout: 12_000, maximumAge: 300_000 },
    );
  });

  // ------------------------------------------------------------- card de resultado
  const textoCompartilhar = (ibge: string, m: MunRow): string => {
    const ref = store.refMun?.[ibge];
    const nome = ref?.nome ?? ibge;
    const [a, b] = store.principais;
    const ca = nomeProprio(store.cand(a).nome);
    const cb = nomeProprio(store.cand(b).nome);
    return `${nome}-${m.uf}: ${ca} ${fmtPct(m.pct[a] ?? 0, 1)} × ${cb} ${fmtPct(m.pct[b] ?? 0, 1)} (${fmtPct(m.pctApurado, 1)} das seções). Acompanhe: ${urlBase()}#m=${ibge}`;
  };

  const linkDe = (ibge: string) => `${urlBase()}#m=${ibge}`;

  const compartilhar = async (ibge: string, m: MunRow) => {
    const texto = textoCompartilhar(ibge, m);
    const url = linkDe(ibge);
    try {
      const blob = await desenharCard(store, ibge, m);
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (blob && nav.share && nav.canShare) {
        const file = new File([blob], `apuracao-${ibge}.png`, { type: 'image/png' });
        const dados: ShareData = { files: [file], text: texto, title: 'Apuração 2026' };
        if (nav.canShare(dados)) {
          await nav.share(dados);
          return;
        }
      }
      if (nav.share && nav.canShare?.({ text: texto, url })) {
        await nav.share({ text: texto, url });
        return;
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      console.warn('share', e);
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  };

  const copiarLink = async (ibge: string) => {
    const url = linkDe(ibge);
    try {
      await navigator.clipboard.writeText(url);
      mostrarToast('Link copiado');
    } catch {
      window.prompt('Copie o link:', url);
    }
  };

  const renderResultado = () => {
    resultado.replaceChildren();
    if (!aberto || !store.meta) return;
    const ibge = aberto;
    const ref = store.refMun?.[ibge];
    const m = store.mun?.get(ibge) ?? null;
    const nome = ref?.nome ?? m?.ibge ?? ibge;
    const uf = ref?.uf ?? m?.uf ?? '';
    const head = el(
      'div',
      { class: 'mun-head' },
      el('div', {}, el('h3', { text: nome }), el('div', { class: 's', text: `${store.nomeUf(uf)} · ${uf}${ref?.capital ? ' · capital' : ''}` })),
      linkFonte(urlFonteMun(store, ibge)),
    );
    resultado.append(head);
    if (!m) {
      resultado.append(el('div', { class: 'empty', text: store.mun ? 'Município sem dados no arquivo do TSE.' : 'Carregando os dados municipais…' }));
      return;
    }
    resultado.append(
      el('div', { class: 'mini-progress', 'aria-hidden': 'true' }, el('i', { style: `width:${m.pctApurado}%` })),
      el('div', { class: 's num', text: `${fmtPct(m.pctApurado, 1)} das seções totalizadas (${fmtInt(m.secTotalizadas)} de ${fmtInt(m.secTotal)})` }),
    );
    if (m.liderIdx < 0) {
      resultado.append(el('div', { class: 'empty', text: 'Nenhuma seção totalizada ainda neste município.' }));
    } else {
      const rows = el('div', { class: 'cand-rows' });
      const ordem = [...store.principais].sort((x, y) => (m.v[y] ?? 0) - (m.v[x] ?? 0));
      const maxPct = Math.max(...ordem.map((i) => m.pct[i] ?? 0), 1);
      for (const i of ordem) {
        const c = store.cand(i);
        rows.append(
          el(
            'div',
            { class: 'cand-row' },
            el('div', { class: 'who' }, el('i', { class: 'sw', style: `background:${store.paleta.cores[i]}` }), el('span', { class: 'n', text: nomeProprio(c.nome) }), el('span', { class: 'p', text: c.partido })),
            el('div', { class: 'v' }, fmtPct(m.pct[i] ?? 0), el('small', { text: fmtInt(m.v[i] ?? 0) })),
            el('div', { class: 'bar' }, el('i', { style: `width:${((m.pct[i] ?? 0) / maxPct) * 100}%;background:${store.paleta.cores[i]}` })),
          ),
        );
      }
      resultado.append(rows);
      const lider = store.cand(m.liderIdx);
      const pctComp = m.aptos > 0 ? (m.comparecimento / m.aptos) * 100 : 0;
      resultado.append(
        el(
          'div',
          { class: 'meta' },
          el('div', {}, 'Margem', el('b', { class: 'num', text: `${fmtPP(m.margemPct)}` }), el('small', { text: nomeProprio(lider.nome).split(' ')[0] })),
          el('div', {}, 'Comparecimento', el('b', { class: 'num', text: fmtPct(pctComp, 1) })),
          el('div', {}, 'Votos válidos', el('b', { class: 'num', text: fmtInt(m.validos) })),
          el('div', {}, 'Brancos e nulos', el('b', { class: 'num', text: m.comparecimento > 0 ? fmtPct(((m.brancos + m.nulos) / m.comparecimento) * 100, 1) : '–' })),
        ),
      );
      // comparação com o Brasil
      const br = store.br;
      if (br) {
        const [a, b] = store.principais;
        resultado.append(
          el(
            'div',
            { class: 'mun-br' },
            el('span', { class: 'l', text: 'No Brasil:' }),
            el('span', { class: 'num' }, el('i', { class: 'sw', style: `background:${store.paleta.cores[a]}` }), `${nomeProprio(store.cand(a).nome).split(' ')[0]} ${fmtPct(br.pct[a] ?? 0, 1)}`),
            el('span', { class: 'x', text: '×' }),
            el('span', { class: 'num' }, el('i', { class: 'sw', style: `background:${store.paleta.cores[b]}` }), `${nomeProprio(store.cand(b).nome).split(' ')[0]} ${fmtPct(br.pct[b] ?? 0, 1)}`),
          ),
        );
      }
    }
    const bShare = el('button', { class: 'btn primary', type: 'button', text: 'Compartilhar' });
    const bCopy = el('button', { class: 'btn', type: 'button', text: 'Copiar link' });
    const bMapa = el('button', { class: 'btn', type: 'button', text: 'Ver no mapa' });
    bShare.disabled = m.liderIdx < 0;
    bShare.addEventListener('click', () => void compartilhar(ibge, m));
    bCopy.addEventListener('click', () => void copiarLink(ibge));
    bMapa.addEventListener('click', () => verNoMapa(ibge, uf));
    resultado.append(el('div', { class: 'mun-acoes' }, bShare, bCopy, bMapa));
  };

  const verNoMapa = (ibge: string, uf: string) => {
    if (uf) store.selecionarUf(uf);
    secao.mapa.realcarMun(ibge);
    document.getElementById('mapa')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const abrir: MunicipioApi['abrir'] = (ibge, opts = {}) => {
    aberto = ibge;
    const ref = store.refMun?.[ibge];
    if (ref && !input.value) input.value = `${ref.nome} - ${ref.uf}`;
    renderResultado();
    if (location.hash !== `#m=${ibge}`) history.replaceState(null, '', `#m=${ibge}`);
    if (opts.mapa) {
      const uf = ref?.uf ?? store.mun?.get(ibge)?.uf ?? '';
      if (uf) store.selecionarUf(uf);
      secao.mapa.realcarMun(ibge);
    }
    if (opts.rolar) raiz.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  store.on('ref', () => {
    montarIndice();
    renderResultado();
  });
  store.on(['mun', 'br', 'tema', 'meta'], renderResultado);
  montarIndice();

  return { abrir, raiz };
}

// ------------------------------------------------------------------ card 1080×1080 (canvas)
async function desenharCard(store: Store, ibge: string, m: MunRow): Promise<Blob | null> {
  const W = 1080;
  const H = 1080;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const ref = store.refMun?.[ibge];
  const nome = ref?.nome ?? ibge;
  const uf = ref?.uf ?? m.uf;
  const bg = '#111113';
  const ink = '#f4f3ee';
  const ink2 = '#c3c2b7';
  const muted = '#8e8d86';
  const font = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const P = 72;
  ctx.textBaseline = 'alphabetic';
  // kicker
  ctx.fillStyle = muted;
  ctx.font = `600 26px ${font}`;
  const meta = store.meta;
  ctx.fillText(`APURAÇÃO ${meta.data_eleicao.slice(0, 4)} · ${meta.turno}º TURNO · ${meta.cargo_nome.toUpperCase()}`, P, P + 26);
  // nome do município (encolhe até caber)
  let tam = 88;
  ctx.fillStyle = ink;
  do {
    ctx.font = `800 ${tam}px ${font}`;
    tam -= 4;
  } while (ctx.measureText(nome).width > W - P * 2 && tam > 40);
  ctx.fillText(nome, P, P + 150);
  ctx.fillStyle = ink2;
  ctx.font = `500 34px ${font}`;
  ctx.fillText(`${store.nomeUf(uf)} · ${uf}`, P, P + 204);
  // progresso de seções
  const yProg = P + 250;
  ctx.fillStyle = '#232327';
  roundRect(ctx, P, yProg, W - P * 2, 10, 5);
  ctx.fill();
  ctx.fillStyle = ink;
  roundRect(ctx, P, yProg, Math.max(10, ((W - P * 2) * m.pctApurado) / 100), 10, 5);
  ctx.fill();
  ctx.fillStyle = ink2;
  ctx.font = `600 28px ${font}`;
  ctx.fillText(`${fmtPct(m.pctApurado, 1)} das seções totalizadas`, P, yProg + 52);

  // candidatos (dois principais, do mais votado para o menos)
  const ordem = [...store.principais].sort((x, y) => (m.v[y] ?? 0) - (m.v[x] ?? 0));
  const colW = (W - P * 2 - 48) / 2;
  const yC = yProg + 120;
  ordem.forEach((i, k) => {
    const c = store.cand(i);
    const cor = corCandidato(c.cor, true);
    const x0 = P + k * (colW + 48);
    // avatar
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x0 + 44, yC + 44, 44, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = textoSobre(cor);
    ctx.font = `800 34px ${font}`;
    ctx.textAlign = 'center';
    ctx.fillText(iniciais(c.nome), x0 + 44, yC + 56);
    ctx.textAlign = 'left';
    // nome + partido
    ctx.fillStyle = ink;
    let tn = 40;
    const nomeC = nomeProprio(c.nome);
    do {
      ctx.font = `800 ${tn}px ${font}`;
      tn -= 2;
    } while (ctx.measureText(nomeC).width > colW - 110 && tn > 22);
    ctx.fillText(nomeC, x0 + 108, yC + 40);
    ctx.fillStyle = muted;
    ctx.font = `500 26px ${font}`;
    ctx.fillText(`${c.partido} · ${c.numero}`, x0 + 108, yC + 76);
    // percentual gigante + votos
    ctx.fillStyle = ink;
    ctx.font = `800 128px ${font}`;
    ctx.fillText(fmtPct(m.pct[i] ?? 0, 1), x0, yC + 240);
    ctx.fillStyle = ink2;
    ctx.font = `500 30px ${font}`;
    ctx.fillText(`${fmtInt(m.v[i] ?? 0)} votos`, x0, yC + 290);
  });

  // barra da disputa
  const yBar = yC + 340;
  const [a, b] = ordem;
  const pa = m.pct[a] ?? 0;
  const pb = m.pct[b] ?? 0;
  const total = W - P * 2;
  const wa = (total * pa) / 100;
  const wb = (total * pb) / 100;
  ctx.fillStyle = '#232327';
  roundRect(ctx, P, yBar, total, 28, 8);
  ctx.fill();
  ctx.fillStyle = corCandidato(store.cand(a).cor, true);
  roundRect(ctx, P, yBar, Math.max(0, wa - 2), 28, 8);
  ctx.fill();
  ctx.fillStyle = corCandidato(store.cand(b).cor, true);
  roundRect(ctx, P + total - wb + 2, yBar, Math.max(0, wb - 2), 28, 8);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.fillRect(P + total / 2 - 2, yBar - 8, 4, 44);
  // margem
  ctx.fillStyle = ink2;
  ctx.font = `500 30px ${font}`;
  ctx.textAlign = 'center';
  ctx.fillText(`${nomeProprio(store.cand(a).nome)} lidera por ${fmtPP(m.margemPct)} · ${fmtInt(m.validos)} votos válidos`, W / 2, yBar + 84);
  ctx.textAlign = 'left';

  // rodapé
  ctx.fillStyle = '#2b2b30';
  ctx.fillRect(P, H - P - 92, W - P * 2, 2);
  ctx.fillStyle = muted;
  ctx.font = `500 26px ${font}`;
  ctx.fillText('Fonte: TSE · dados oficiais, sem projeções', P, H - P - 44);
  ctx.textAlign = 'right';
  ctx.fillStyle = ink2;
  ctx.font = `600 26px ${font}`;
  ctx.fillText(`${location.host}${location.pathname}#m=${ibge}`.replace(/\/#/, '#'), W - P, H - P - 44);
  ctx.textAlign = 'left';

  return new Promise((resolve) => cv.toBlob((b) => resolve(b), 'image/png'));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
