// Reações em explosão (docs/CHAT.md › Extensões): barra de emojis + "torcida" dos
// finalistas e a camada de emojis subindo sobre a lista de mensagens, estilo Twitch.
// Com prefers-reduced-motion, mostra contadores em vez de animar.

import { textoSobre } from '../color';
import { el, iniciais, reduzMovimento } from '../format';
import { MAX_REACOES_S, REACOES_EMOJI } from './client';

/** Finalista para o botão de torcida (id de meta.cands, nome curto e cor de exibição). */
export interface Torcida {
  id: string;
  nome: string;
  cor: string;
}

export interface Reacoes {
  /** Linha de botões (vai abaixo da lista de mensagens). */
  barra: HTMLElement;
  /** Camada absoluta sobre a lista onde os emojis sobem. */
  camada: HTMLElement;
  setTorcidas(t: Torcida[]): void;
  /** Anima uma janela de `reacoes` do servidor. */
  explodir(contagem: Record<string, number>): void;
  /** Esvazia a camada (troca de sala). */
  limpar(): void;
  setAtivo(v: boolean): void;
}

export interface ReacoesOpts {
  /** Envia a reação; devolve false sem conexão. */
  aoReagir: (valor: string) => boolean;
}

const CAP_EXPLOSAO = 40; // emojis por janela
const MAX_NA_CAMADA = 90; // segurança contra rajadas sobrepostas
const JANELA_MS = 1000;

export function montarReacoes(opts: ReacoesOpts): Reacoes {
  const camada = el('div', { class: 'chat-burst', 'aria-hidden': 'true' });
  const badges = el('div', { class: 'chat-react-badges', 'aria-hidden': 'true' });
  const emojis = el('div', { class: 'chat-react-emojis', role: 'group', 'aria-label': 'Reações' });
  const torcidas = el('div', { class: 'chat-react-torcida', role: 'group', 'aria-label': 'Torcida' });
  const barra = el('div', { class: 'chat-react' }, emojis, torcidas, badges);

  // ---------------------------------------------------------------- envio com limite 5/s
  const envios: number[] = [];
  let ativo = true;
  const reagir = (valor: string, btn: HTMLButtonElement) => {
    if (!ativo) return;
    const agora = performance.now();
    while (envios.length && envios[0] < agora - JANELA_MS) envios.shift();
    if (envios.length >= MAX_REACOES_S) {
      btn.classList.remove('tap');
      return; // excesso ignorado em silêncio, como no servidor
    }
    if (!opts.aoReagir(valor)) return;
    envios.push(agora);
    // retorno imediato: "haptic" visual + um emoji meu subindo
    btn.classList.remove('tap');
    void btn.offsetWidth;
    btn.classList.add('tap');
    if (!reduzMovimento()) soltar(valor, 0, true);
  };

  for (const e of REACOES_EMOJI) {
    const b = el('button', { class: 'rbtn', type: 'button', 'aria-label': `Reagir com ${e}`, text: e });
    b.addEventListener('click', () => reagir(e, b));
    emojis.append(b);
  }
  // teclado: setas percorrem os botões do grupo
  barra.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const botoes = [...barra.querySelectorAll<HTMLButtonElement>('button')];
    const i = botoes.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    ev.preventDefault();
    botoes[(i + (ev.key === 'ArrowRight' ? 1 : botoes.length - 1)) % botoes.length].focus();
  });

  let lista: Torcida[] = [];
  const porId = new Map<string, Torcida>();
  const renderTorcidas = () => {
    torcidas.replaceChildren();
    porId.clear();
    for (const t of lista) {
      porId.set(t.id, t);
      const b = el(
        'button',
        { class: 'rbtn rbtn-torcida', type: 'button', title: `Torcer por ${t.nome}`, 'aria-label': `Torcer por ${t.nome}`, style: `--cor:${t.cor};--sobre:${textoSobre(t.cor)}` },
        el('i', { class: 'ini', 'aria-hidden': 'true', text: iniciais(t.nome) }),
        el('span', { class: 'nm', text: primeiroNome(t.nome) }),
      );
      b.addEventListener('click', () => reagir(`torcida:${t.id}`, b));
      torcidas.append(b);
    }
    torcidas.hidden = lista.length === 0;
  };
  renderTorcidas();

  // ---------------------------------------------------------------- explosão
  const noFlutuante = (valor: string, meu: boolean): HTMLElement | null => {
    if (valor.startsWith('torcida:')) {
      const t = porId.get(valor.slice(8));
      if (!t) return null;
      return el('span', { class: `rx rx-torcida${meu ? ' meu' : ''}`, style: `--cor:${t.cor};--sobre:${textoSobre(t.cor)}`, text: iniciais(t.nome) });
    }
    return el('span', { class: `rx${meu ? ' meu' : ''}`, text: valor });
  };

  function soltar(valor: string, atrasoMs: number, meu = false): void {
    if (camada.childElementCount >= MAX_NA_CAMADA) return;
    const no = noFlutuante(valor, meu);
    if (!no) return;
    const x = meu ? 78 + Math.random() * 16 : 4 + Math.random() * 92;
    const dx = (Math.random() - 0.5) * 90;
    const dur = 1500 + Math.random() * 1100;
    const esc = (0.8 + Math.random() * 0.7).toFixed(2);
    const rot = ((Math.random() - 0.5) * 50).toFixed(0);
    const up = Math.max(80, camada.clientHeight - 36);
    no.style.cssText += `;--x:${x.toFixed(1)}%;--dx:${dx.toFixed(0)}px;--s:${esc};--rot:${rot}deg;--up:${up}px;animation-duration:${dur.toFixed(0)}ms;animation-delay:${atrasoMs.toFixed(0)}ms`;
    no.addEventListener('animationend', () => no.remove(), { once: true });
    camada.append(no);
  }

  const explodirReduzido = (contagem: Record<string, number>) => {
    for (const [valor, n] of Object.entries(contagem)) {
      if (!(n > 0)) continue;
      const rotulo = valor.startsWith('torcida:') ? porId.get(valor.slice(8))?.nome : valor;
      if (!rotulo) continue;
      const b = el('span', { class: 'rx-badge', text: `${rotulo} ×${n}` });
      badges.append(b);
      window.setTimeout(() => b.remove(), 2400);
    }
  };

  const reacoes: Reacoes = {
    barra,
    camada,
    setTorcidas(t) {
      lista = t;
      renderTorcidas();
    },
    explodir(contagem) {
      if (!contagem || typeof contagem !== 'object') return;
      if (reduzMovimento() || document.visibilityState === 'hidden') {
        if (document.visibilityState !== 'hidden') explodirReduzido(contagem);
        return;
      }
      const entradas = Object.entries(contagem).filter(([, n]) => n > 0);
      const total = entradas.reduce((s, [, n]) => s + n, 0);
      if (!total) return;
      const escala = total > CAP_EXPLOSAO ? CAP_EXPLOSAO / total : 1;
      for (const [valor, n] of entradas) {
        const k = Math.max(1, Math.round(n * escala));
        for (let i = 0; i < k; i++) soltar(valor, Math.random() * 1400);
      }
    },
    limpar() {
      camada.replaceChildren();
      badges.replaceChildren();
    },
    setAtivo(v) {
      ativo = v;
      barra.classList.toggle('inativo', !v);
      for (const b of barra.querySelectorAll<HTMLButtonElement>('button')) b.disabled = !v;
    },
  };
  return reacoes;
}

function primeiroNome(nome: string): string {
  return nome.split(/\s+/)[0] ?? nome;
}
