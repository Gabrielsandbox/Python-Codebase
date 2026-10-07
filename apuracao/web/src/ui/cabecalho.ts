import type { Ciclo, Poller } from '../api';
import { el, fmtDataLonga, fmtHoraSeg, pulsar, reduzMovimento, svgEl } from '../format';
import type { Store } from '../store';
import { montarToggleTema } from '../tema';
import { montarBotaoWhatsApp } from './whatsapp';

const ordinal = (n: number) => `${n}º turno`;

/** Período do ciclo de verificação exibido no anel/barra (br/uf/status: 10 s). */
const PERIODO_PADRAO = 10_000;

export function montarCabecalho(raiz: HTMLElement, store: Store, poller: Poller): void {
  const titulo = el('h1', { text: 'Apuração 2026' });
  const sub = el('span', { class: 'sub' });
  const badgeLongo = el('span', { class: 'long', text: '…' });
  const badgeCurto = el('span', { class: 'short', 'aria-hidden': 'true', text: '…' });
  const badge = el('span', { class: 'badge', role: 'status' }, el('i', { class: 'dot', 'aria-hidden': 'true' }), badgeLongo, badgeCurto);

  // ---- indicador "ao vivo": batimento + contador de segundos + anel + hora do TSE
  const batimento = el('i', { class: 'beat', 'aria-hidden': 'true' });
  const segundos = el('span', { class: 'secs num' }, el('span', { class: 'digit', text: '0' }));
  const digito = segundos.firstElementChild as HTMLElement;
  const novos = el('span', { class: 'fresh', text: 'novos dados', hidden: true });
  const anuncio = el('span', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const tse = el('span', { class: 'tse num' });

  // anel de "próxima verificação": SVG 18×18, r=7 → circunferência ≈ 43.98
  const R = 7;
  const CIRC = 2 * Math.PI * R;
  const trilha = svgEl('circle', { cx: 9, cy: 9, r: R, class: 'track' });
  const arco = svgEl('circle', { cx: 9, cy: 9, r: R, class: 'arc', 'stroke-dasharray': CIRC.toFixed(3), 'stroke-dashoffset': '0' });
  const anel = svgEl('svg', { class: 'ring', viewBox: '0 0 18 18', width: 18, height: 18, 'aria-hidden': 'true' });
  anel.append(trilha, arco);
  const anelWrap = el('span', { class: 'ring-wrap', title: 'próxima verificação' }, anel);

  const indicador = el(
    'div',
    { class: 'live-ind', title: 'Verificamos o TSE a cada 10 s; os dados oficiais mudam cerca de uma vez por minuto.' },
    batimento,
    el('span', { class: 'lbl', text: 'verificado ' }),
    segundos,
    anelWrap,
    el('span', { class: 'sep', 'aria-hidden': 'true', text: '·' }),
    tse,
    novos,
    anuncio,
  );

  // barra de 2 px no topo da página: varre em cada ciclo de verificação
  const sweep = el('i', { class: 'sweep-fill' });
  const sweepBar = el('div', { class: 'sweep', 'aria-hidden': 'true' }, sweep);
  document.body.prepend(sweepBar);

  raiz.append(
    el(
      'div',
      { class: 'topbar-inner' },
      el('div', { class: 'brand' }, titulo, sub),
      el('div', { class: 'status' }, indicador, badge, montarBotaoWhatsApp(store, { compacto: true }), montarToggleTema(store)),
    ),
  );

  const renderMeta = () => {
    const m = store.meta;
    sub.replaceChildren(
      el('span', { class: 'long', text: `${ordinal(m.turno)} · ${m.cargo_nome} · ${fmtDataLonga(m.data_eleicao)}` }),
      el('span', { class: 'short', text: `${ordinal(m.turno)} · ${m.cargo_nome}` }),
    );
    document.title = `Apuração 2026 — ${ordinal(m.turno)} · ${m.cargo_nome}`;
  };

  const renderBadge = () => {
    const s = store.status;
    const br = store.br;
    badge.classList.remove('live', 'wait', 'done');
    const set = (cls: string, longo: string, curto: string) => {
      badge.classList.add(cls);
      badgeLongo.textContent = longo;
      badgeCurto.textContent = curto;
    };
    if (s?.aguardando_totalizacao) set('wait', 'aguardando totalização', 'aguardando');
    else if (br && br.secoes.pct >= 100) set('done', 'totalização concluída', 'concluída');
    else set('live', 'ao vivo', 'ao vivo');
  };

  const renderTse = () => {
    const br = store.br;
    tse.textContent = br ? `TSE ${fmtHoraSeg(br.atualizado_em)}` : '';
    tse.title = br ? `Última mudança nos dados oficiais do TSE: ${fmtHoraSeg(br.atualizado_em)}` : '';
  };

  // ---- relógio de 1 s
  let ultimaVerificacao = Date.now();
  let proximaVerificacao: number | null = null;
  let periodo = PERIODO_PADRAO;
  let ultimoTexto = '';
  let timerNovos: number | null = null;

  const fmtSegundos = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `há ${s} s`;
    if (s < 3600) return `há ${Math.floor(s / 60)} min`;
    return `há ${Math.floor(s / 3600)} h`;
  };

  /** Reinicia o anel e a barra do zero sem animar "para trás". */
  const zerar = () => {
    arco.style.transition = 'none';
    sweep.style.transition = 'none';
    arco.setAttribute('stroke-dashoffset', CIRC.toFixed(3));
    sweep.style.transform = 'scaleX(0)';
    void sweepBar.offsetWidth;
    arco.style.transition = '';
    sweep.style.transition = '';
  };

  const tique = () => {
    const agora = Date.now();
    const texto = fmtSegundos(agora - ultimaVerificacao);
    if (texto !== ultimoTexto) {
      ultimoTexto = texto;
      digito.textContent = texto;
      if (!reduzMovimento()) pulsar(digito, 'tick');
    }
    // anel/barra: progresso até a próxima verificação (alvo = 1 s à frente, p/ transição linear)
    if (proximaVerificacao !== null) {
      const alvo = agora + 1000;
      const p = Math.min(1, Math.max(0, 1 - (proximaVerificacao - alvo) / periodo));
      arco.setAttribute('stroke-dashoffset', (CIRC * (1 - p)).toFixed(3));
      sweep.style.transform = `scaleX(${p.toFixed(4)})`;
      indicador.classList.remove('paused');
    } else {
      indicador.classList.add('paused');
    }
  };

  const aoCiclo = (c: Ciclo) => {
    // o anel segue o arquivo principal (br.json, a cada 10 s)
    if (c.chave !== 'br') return;
    ultimaVerificacao = c.em;
    proximaVerificacao = c.proximo;
    periodo = c.intervalo;
    indicador.classList.toggle('offline', !c.ok);
    if (c.ok) {
      zerar();
      tique();
    }
    if (c.mudou) {
      pulsar(indicador, 'fresh-flash');
      novos.hidden = false;
      anuncio.textContent = '';
      // troca em dois tempos para o leitor de tela anunciar sempre
      requestAnimationFrame(() => (anuncio.textContent = `Novos dados do TSE às ${fmtHoraSeg(new Date(c.em).toISOString())}`));
      if (timerNovos) clearTimeout(timerNovos);
      timerNovos = window.setTimeout(() => {
        novos.hidden = true;
        anuncio.textContent = '';
      }, 3500);
    }
  };

  store.on('meta', renderMeta);
  store.on(['status', 'br'], renderBadge);
  store.on('br', renderTse);
  poller.onCiclo(aoCiclo);
  setInterval(tique, 1000);
  tique();
  if (store.meta) renderMeta();
  renderTse();
}
