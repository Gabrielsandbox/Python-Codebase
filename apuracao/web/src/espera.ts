// Página de espera: antes do lançamento o site só pede o WhatsApp (POST /espera no serviço do chat).
import './espera.css';

const CHAT_BASE: string = (import.meta.env.VITE_CHAT_BASE as string | undefined)?.replace(/\/$/, '') || '/chat';
const ESPERA_BASE = CHAT_BASE.replace(/\/chat$/, '') + '/espera';
const MINIMO_PARA_MOSTRAR = 500;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('espera-form');
const input = $<HTMLInputElement>('whatsapp');
const erro = $<HTMLElement>('whatsapp-err');
const btn = $<HTMLButtonElement>('espera-btn');
const ok = $<HTMLElement>('espera-ok');
const numeroEl = $<HTMLElement>('espera-numero');
const wa = $<HTMLAnchorElement>('espera-wa');
const totalEl = $<HTMLElement>('espera-total');

/** (DD) 9XXXX-XXXX enquanto digita. */
function mascara(v: string): string {
  const d = v.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}
input.addEventListener('input', () => {
  input.value = mascara(input.value);
  erro.hidden = true;
});

function validar(): string | null {
  const d = input.value.replace(/\D/g, '');
  if (d.length < 10) return 'Digite o DDD e o número do celular.';
  if (d.length === 11 && d[2] !== '9') return 'Celular começa com 9 depois do DDD.';
  return null;
}

const compartilhar = () => {
  const texto = `Vou acompanhar a apuração do 2º turno ao vivo, município por município, em apuracaoaovivo.com — entra na lista de espera também: https://apuracaoaovivo.com/`;
  wa.href = `https://wa.me/?text=${encodeURIComponent(texto)}`;
};
compartilhar();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = validar();
  if (msg) {
    erro.textContent = msg;
    erro.hidden = false;
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  try {
    const r = await fetch(ESPERA_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ whatsapp: input.value, origem: document.referrer ? new URL(document.referrer).hostname.slice(0, 64) : 'direto' }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; whatsapp?: string; detail?: string };
    if (!r.ok || !j.ok) throw new Error(j.detail || `HTTP ${r.status}`);
    numeroEl.textContent = j.whatsapp ?? input.value;
    form.hidden = true;
    ok.hidden = false;
    try {
      localStorage.setItem('espera_ok', j.whatsapp ?? input.value);
    } catch {
      /* sem armazenamento */
    }
  } catch (err) {
    const m = (err as Error).message;
    erro.textContent = /celular|DDD|válido/i.test(m) ? m : 'Não deu certo agora. Tente de novo em instantes.';
    erro.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Me avisa quando abrir';
  }
});

// quem já entrou vê o estado "pronto" de novo
try {
  const feito = localStorage.getItem('espera_ok');
  if (feito) {
    numeroEl.textContent = feito;
    form.hidden = true;
    ok.hidden = false;
  }
} catch {
  /* sem armazenamento */
}

// prova social: só a partir de 500 na lista
void fetch(`${ESPERA_BASE}/total`, { headers: { Accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((j: { total?: number } | null) => {
    if (j && typeof j.total === 'number' && j.total >= MINIMO_PARA_MOSTRAR) {
      totalEl.textContent = `${j.total.toLocaleString('pt-BR')} pessoas já estão na lista`;
      totalEl.hidden = false;
    }
  })
  .catch(() => undefined);
