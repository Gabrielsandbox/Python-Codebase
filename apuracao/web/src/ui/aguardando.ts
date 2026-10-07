// Estado "aguardando": o site está no ar, mas o TSE ainda não publicou o primeiro boletim
// (meta.json não existe). Mostra o que vem por aí e mantém alertas e chat disponíveis.
import { el, fmtDataLonga, fmtHoraSeg } from '../format';
import type { Ativo, Status } from '../types';
import type { Store } from '../store';
import { montarBotaoWhatsApp, urlPagina } from './whatsapp';

export interface AguardandoApi {
  atualizar(status: Status | null, ok: boolean): void;
}

export function montarAguardando(raiz: HTMLElement, ativo: Ativo, store: Store): AguardandoApi {
  const ano = (ativo.data_eleicao || '').slice(0, 4);
  const quando = ativo.data_eleicao
    ? `${fmtDataLonga(ativo.data_eleicao)}, a partir das 17h (horário de Brasília)`
    : 'no dia da eleição, a partir das 17h (horário de Brasília)';
  const ultima = el('span', { class: 'secs', text: 'verificando o TSE…' });
  const ind = el('p', { class: 'live-ind aguardando-ind' }, el('span', { class: 'beat' }), ultima);

  const share = montarBotaoWhatsApp(store, {
    outrosApps: true,
    texto: () => `Acompanhe a apuração do ${ativo.turno}º turno em tempo real, com mapa por município e dados oficiais do TSE: ${urlPagina()}`,
  });

  raiz.replaceChildren(
    el(
      'div',
      { class: 'card aguardando' },
      el('p', { class: 'hero-kicker', text: `Apuração ${ano} · ${ativo.turno}º turno · Presidente` }),
      el('h1', { text: 'Aguardando o início da apuração' }),
      el('p', { class: 'aguardando-quando', text: quando }),
      el('p', {
        class: 'aguardando-desc',
        text: 'Assim que o TSE publicar o primeiro boletim, esta página passa a mostrar o placar, o mapa por município e o caminho para a vitória, atualizados a cada 10 segundos.',
      }),
      el(
        'ul',
        { class: 'aguardando-lista' },
        el('li', { text: 'Ative os alertas no topo da página para receber o início, as viradas e o resultado.' }),
        el('li', { text: 'O chat ao vivo e o modo telão já podem ser liberados por R$ 5 e valem para toda a apuração.' }),
      ),
      el('div', { class: 'aguardando-acoes' }, share),
      ind,
    ),
  );
  document.title = `Apuração ${ano} — ${ativo.turno}º turno · aguardando`;

  return {
    atualizar(status, ok) {
      ind.classList.toggle('offline', !ok);
      if (!ok) {
        ultima.textContent = 'sem conexão com os dados · tentando de novo';
        return;
      }
      const hora = status?.ultima_coleta ? fmtHoraSeg(status.ultima_coleta) : '';
      ultima.textContent = hora ? `coletor ativo · TSE verificado às ${hora} · nenhum boletim publicado ainda` : 'coletor ativo · nenhum boletim publicado ainda';
    },
  };
}
