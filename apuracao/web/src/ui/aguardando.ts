// Estado "aguardando": o site está no ar, mas o TSE ainda não publicou o primeiro boletim
// (meta.json não existe). Só o essencial: quando começa e o botão de compartilhar.
import { el, fmtDataLonga } from '../format';
import type { Store } from '../store';
import type { Ativo, Status } from '../types';
import { montarBotaoWhatsApp, urlPagina } from './whatsapp';

export interface AguardandoApi {
  atualizar(status: Status | null, ok: boolean): void;
}

export function montarAguardando(raiz: HTMLElement, ativo: Ativo, store: Store): AguardandoApi {
  const ano = (ativo.data_eleicao || '').slice(0, 4);
  const quando = ativo.data_eleicao ? `${fmtDataLonga(ativo.data_eleicao)} · 17h` : 'dia da eleição · 17h';
  const share = montarBotaoWhatsApp(store, {
    outrosApps: true,
    texto: () => `Acompanhe a apuração do ${ativo.turno}º turno em tempo real, com mapa por município e dados oficiais do TSE: ${urlPagina()}`,
  });
  raiz.replaceChildren(
    el(
      'div',
      { class: 'card aguardando' },
      el('p', { class: 'hero-kicker', text: `${ativo.turno}º turno · ${quando}` }),
      el('h1', { text: 'Aguardando o início da apuração' }),
      share,
    ),
  );
  document.title = `Apuração ${ano} — ${ativo.turno}º turno · aguardando`;
  return { atualizar() {} };
}
