// "Caminho para a vitória" (docs/RECURSOS.md §1): aritmética sobre os votos válidos que
// ainda faltam — quanto o segundo precisa para empatar, onde estão esses votos (regiões e
// maiores municípios abertos) e o ritmo da contagem. Nunca é projeção de resultado.

import { el, fmtCompact, fmtInt, fmtPct, nomeProprio } from '../format';
import type { Store } from '../store';
import type { Caminho, CaminhoLugar } from '../types';
import { EXPLICACAO_RITMO, serieRitmo, sparkline, textoRitmo } from './ritmo';

const REGIOES = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];

interface Finalista {
  id: string;
  idx: number; // índice em meta.cands (-1 se desconhecido)
  nome: string;
  cor: string;
}

/** "≈ 11,2 mi" / "≈ 450 mil" / "≈ 870". */
export const fmtAprox = (n: number): string => `≈ ${n >= 1000 ? fmtCompact(n) : fmtInt(n)}`;

export function finalistas(store: Store, c: Caminho): Finalista[] {
  return c.cands.map((id) => {
    const idx = store.idx(id);
    const cand = idx >= 0 ? store.cand(idx) : null;
    return {
      id,
      idx,
      nome: cand ? nomeProprio(cand.nome) : id,
      cor: idx >= 0 ? store.paleta.cores[idx] : '#888888',
    };
  });
}

/** Barra dividida em dois segmentos (base_pct) com vão de 2 px na cor da superfície. */
function barraDividida(pct: number[], fins: Finalista[], larguraPct = 100, classe = 'split'): HTMLElement {
  const a = Math.max(0, Math.min(100, pct[0] ?? 50));
  const bar = el('div', { class: classe, style: `width:${larguraPct}%`, 'aria-hidden': 'true' });
  bar.append(
    el('i', { style: `flex-basis:${a}%;background:${fins[0].cor}` }),
    el('i', { style: `flex-basis:${100 - a}%;background:${fins[1].cor}` }),
  );
  return bar;
}

/** Resumo em uma linha para o telão/rodapés: "Faltam ≈ 11,2 mi votos · Lula precisa de 56,3%". */
export function resumoCaminho(store: Store, c: Caminho | null): { faltam: string; precisa: string | null } | null {
  if (!c || !store.meta) return null;
  if (c.restante.pct_secoes >= 100) return { faltam: 'A totalização ainda não começou', precisa: null };
  if (c.restante.secoes === 0) return { faltam: 'Todas as seções totalizadas', precisa: null };
  const fins = finalistas(store, c);
  const faltam = `Faltam ${fmtAprox(c.restante.votos_est)} votos (${fmtPct(c.restante.pct_secoes, 1)} das seções)`;
  const atras = fins.map((f) => ({ f, n: c.necessario[f.id] })).filter((x) => x.n !== null && x.n !== undefined && x.n > 50)[0];
  if (!atras) return { faltam, precisa: null };
  const n = atras.n as number;
  return { faltam, precisa: n > 100 ? `${atras.f.nome}: matematicamente impossível empatar` : `${atras.f.nome} precisa de ${fmtPct(n, 1)} dos votos que faltam` };
}

export function montarCaminho(raiz: HTMLElement, store: Store): void {
  const corpo = el('div', { class: 'cam-body' });
  const card = el(
    'div',
    { class: 'card cam-card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', { text: 'Caminho para a vitória' }),
      el('span', { class: 'sub', text: 'aritmética dos votos que faltam · não é projeção' }),
    ),
    corpo,
  );
  raiz.hidden = true;
  raiz.append(card);

  const render = () => {
    const c = store.caminho;
    if (!c || !store.meta || c.cands.length !== 2) {
      raiz.hidden = true;
      return;
    }
    raiz.hidden = false;
    const fins = finalistas(store, c);
    const r = c.restante;
    corpo.replaceChildren();

    // ---- banner: matematicamente definido (o selo "Eleito" continua sendo do TSE)
    if (c.definido_matematicamente) {
      const f = fins.find((x) => x.id === c.definido_matematicamente);
      corpo.append(
        el(
          'div',
          { class: 'cam-banner', role: 'status' },
          el('i', { class: 'sw', style: `background:${f?.cor ?? 'var(--ink)'}` }),
          el('span', {}, 'Matematicamente definido: ', el('strong', { text: f?.nome ?? c.definido_matematicamente }), '. Aguardando o TSE.'),
        ),
      );
    }

    // ---- estado: antes da totalização
    if (r.pct_secoes >= 100) {
      corpo.append(
        el(
          'div',
          { class: 'cam-calm' },
          el('div', { class: 'h', text: 'A totalização ainda não começou' }),
          el('div', { class: 's', text: `Quando as primeiras seções chegarem, mostramos aqui quantos votos faltam e quanto cada candidato precisa deles para empatar. Base: ${c.base.descricao}.` }),
        ),
      );
      corpo.append(blocoRitmo());
      return;
    }

    // ---- estado: concluída
    if (r.secoes === 0) {
      corpo.append(
        el(
          'div',
          { class: 'cam-calm' },
          el('div', { class: 'h', text: 'Todas as seções foram totalizadas' }),
          el('div', { class: 's', text: 'Não há mais votos a contar. O resultado oficial é o do TSE.' }),
        ),
      );
      return;
    }

    // ---- manchete: quanto falta
    corpo.append(
      el(
        'div',
        { class: 'cam-head' },
        el('div', { class: 'cam-faltam' }, 'Faltam ', el('span', { class: 'big', text: fmtAprox(r.votos_est) }), ' votos'),
        el('div', { class: 'cam-sub num', text: `${fmtPct(r.pct_secoes, 1)} das seções · ${fmtInt(r.municipios_abertos)} municípios abertos` }),
      ),
    );

    // ---- gauge: quanto o segundo precisa para empatar
    const nec = fins.map((f) => ({ f, n: c.necessario[f.id] ?? null }));
    const atras = nec.find((x) => x.n !== null && x.n > 50) ?? null;
    const empate = !atras && nec.every((x) => x.n !== null && Math.abs(x.n - 50) < 0.05);
    if (atras && atras.n !== null) {
      const n = atras.n;
      const impossivel = n > 100;
      const marcador = Math.min(100, n);
      const gauge = el(
        'div',
        { class: `gauge${impossivel ? ' imp' : ''}`, role: 'img', 'aria-label': `${atras.f.nome} precisa de ${fmtPct(n, 1)} dos votos que faltam para empatar` },
        el('div', { class: 'track' }, el('i', { class: 'fill', style: `width:${marcador}%;background:${atras.f.cor}` })),
        el('span', { class: 'tick half', style: 'left:50%' }, el('b'), Math.abs(marcador - 50) >= 7 ? el('small', { text: '50%' }) : null),
        el('span', { class: 'tick need', style: `left:${marcador}%` }, el('b', { style: `background:${atras.f.cor}` }), impossivel ? null : el('small', { class: 'num', text: fmtPct(n, 1) })),
        el('span', { class: 'end', text: '0' }),
        el('span', { class: 'end r', text: impossivel ? '>100%' : '100%' }),
      );
      corpo.append(
        el(
          'div',
          { class: 'cam-need' },
          el(
            'p',
            { class: 'txt' },
            el('i', { class: 'sw', style: `background:${atras.f.cor}` }),
            el('strong', { text: atras.f.nome }),
            impossivel ? ' precisaria de mais de 100% dos votos que faltam — ' : ' precisa de ',
            impossivel ? el('strong', { text: 'matematicamente impossível' }) : el('strong', { class: 'num', text: fmtPct(n, 1) }),
            impossivel ? ' empatar.' : ' dos votos que faltam para empatar.',
          ),
          gauge,
        ),
      );
    } else if (empate) {
      corpo.append(el('p', { class: 'cam-need txt', text: 'Empate: cada candidato precisa de 50% dos votos que faltam para seguir empatado.' }));
    }

    // ---- regiões: onde estão os votos que faltam, divididos pela base do 1º turno
    const regioes = REGIOES.map((nome) => [nome, c.por_regiao[nome]] as const)
      .filter((x): x is readonly [string, CaminhoLugar] => !!x[1])
      .sort((a, b) => b[1].votos_est - a[1].votos_est);
    if (regioes.length) {
      const max = Math.max(...regioes.map(([, l]) => l.votos_est), 1);
      const lista = el('div', { class: 'cam-reg', role: 'list' });
      for (const [nome, l] of regioes) {
        const w = Math.max(1.5, (l.votos_est / max) * 72); // deixa espaço para o rótulo na ponta
        lista.append(
          el(
            'div',
            { class: 'row', role: 'listitem', title: `${nome}: ${fmtAprox(l.votos_est)} votos em ${fmtInt(l.secoes)} seções (${fmtPct(l.pct_secoes_restantes, 1)} das seções da região). No 1º turno, ${fins[0].nome} ${fmtPct(l.base_pct[0] ?? 0, 1)} × ${fins[1].nome} ${fmtPct(l.base_pct[1] ?? 0, 1)}.` },
            el('span', { class: 'n' }, nome, el('small', { class: 'num', text: `${fmtPct(l.pct_secoes_restantes, 1)} das seções` })),
            el('span', { class: 'b' }, barraDividida(l.base_pct, fins, w), el('span', { class: 'v num', text: fmtAprox(l.votos_est) })),
          ),
        );
      }
      corpo.append(
        el(
          'div',
          { class: 'cam-sec' },
          el('div', { class: 'cam-t' }, 'Onde estão os votos que faltam', el('span', { class: 'leg' }, ...fins.map((f) => el('span', {}, el('i', { class: 'sw', style: `background:${f.cor}` }), f.nome)), el('span', { class: 'mut', text: 'divisão entre os dois no 1º turno' }))),
          lista,
        ),
      );
    }

    // ---- maiores municípios ainda abertos
    const maiores = c.maiores_abertos.slice(0, 8);
    if (maiores.length) {
      const lista = el('div', { class: 'cam-mun', role: 'list' });
      for (const m of maiores) {
        lista.append(
          el(
            'div',
            { class: 'row', role: 'listitem', title: `${m.nome} (${m.uf}): ${fmtPct(m.pct_secoes, 1)} das seções totalizadas. No 1º turno, ${fins[0].nome} ${fmtPct(m.base_pct[0] ?? 0, 1)} × ${fins[1].nome} ${fmtPct(m.base_pct[1] ?? 0, 1)}.` },
            el('span', { class: 'n' }, m.nome, el('small', { text: m.uf })),
            el('span', { class: 'v num', text: fmtAprox(m.votos_est) }),
            el('span', { class: 'p num', text: `${fmtPct(m.pct_secoes, 1)} das seções` }),
            el('span', { class: 'mini' }, barraDividida(m.base_pct, fins, 100, 'split mini-split')),
          ),
        );
      }
      corpo.append(el('div', { class: 'cam-sec' }, el('div', { class: 'cam-t', text: 'Maiores municípios ainda abertos' }), lista));
    }

    corpo.append(blocoRitmo());
    corpo.append(el('p', { class: 'cam-cap', text: `Estimativa pelo comparecimento do 1º turno. Não é projeção de resultado.` }));
  };

  /** Ritmo: texto + sparkline (seções/min calculada da linha do tempo). */
  const blocoRitmo = (): HTMLElement => {
    const r = store.ritmo;
    const serie = serieRitmo(store.timeline, store.br?.secoes.total ?? 0);
    const wrap = el('div', { class: 'cam-ritmo', title: EXPLICACAO_RITMO });
    const atual = serie.length ? serie[serie.length - 1].valor : null;
    if (r) {
      const { principal, nota } = textoRitmo(r);
      wrap.append(
        el('div', { class: 't' }, el('span', { class: 'lbl', text: 'Ritmo' }), el('span', { class: 'num', text: principal }), nota ? el('span', { class: 'nota', text: nota }) : null),
      );
    } else if (atual !== null) {
      wrap.append(el('div', { class: 't' }, el('span', { class: 'lbl', text: 'Ritmo' }), el('span', { class: 'num', text: `${fmtInt(atual)} seções/min` })));
    } else {
      wrap.hidden = true;
      return wrap;
    }
    if (serie.length >= 2) {
      const n = serie.length;
      wrap.append(
        el('div', { class: 'sp' }, sparkline(serie, 140, 30), el('small', { text: `seções/min · últimos ${n} pontos` })),
      );
    }
    wrap.append(el('div', { class: 'why', text: 'Extrapolação da velocidade de contagem, não do resultado.' }));
    return wrap;
  };

  store.on(['caminho', 'br', 'tema', 'meta', 'ritmo', 'timeline'], render);
  render();
}
