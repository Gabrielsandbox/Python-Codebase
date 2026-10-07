import { el, fmtDataLonga, fmtHora, fmtRelativo } from '../format';
import type { Store } from '../store';

const ordinal = (n: number) => `${n}º turno`;

export function montarCabecalho(raiz: HTMLElement, store: Store): void {
  const titulo = el('h1', { text: 'Apuração 2026' });
  const sub = el('span', { class: 'sub' });
  const badgeLongo = el('span', { class: 'long', text: '…' });
  const badgeCurto = el('span', { class: 'short', 'aria-hidden': 'true', text: '…' });
  const badge = el('span', { class: 'badge', role: 'status' }, el('i', { class: 'dot', 'aria-hidden': 'true' }), badgeLongo, badgeCurto);
  const atualizado = el('div', { class: 'updated' });
  raiz.append(
    el(
      'div',
      { class: 'topbar-inner' },
      el('div', { class: 'brand' }, titulo, sub),
      el('div', { class: 'status' }, atualizado, badge),
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

  const renderRelogio = () => {
    const s = store.status;
    atualizado.replaceChildren();
    if (!s) return;
    atualizado.append(
      el('div', {}, 'atualizado ', el('strong', { text: fmtRelativo(s.ultima_coleta) })),
      store.br ? el('div', { class: 'tse', text: `dados do TSE das ${fmtHora(store.br.atualizado_em)}` }) : '',
    );
  };

  store.on('meta', renderMeta);
  store.on(['status', 'br'], () => {
    renderBadge();
    renderRelogio();
  });
  setInterval(renderRelogio, 1000);
  if (store.meta) renderMeta();
}
