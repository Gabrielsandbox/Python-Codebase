// Cliente do chat ao vivo (docs/CHAT.md): HTTP (checkout/acesso/estado) e
// WebSocket com reconexão em backoff exponencial (1 s → 30 s).

/** Só mostramos "N online" a partir deste número: abaixo disso o número desanima mais do que convida. */
export const ONLINE_MINIMO = 500;

export const CHAT_BASE: string = (import.meta.env.VITE_CHAT_BASE as string | undefined)?.replace(/\/$/, '') || '/chat';

const CONTA_BASE = CHAT_BASE.replace(/\/chat$/, '') + '/conta';

export const CHAVE_TOKEN = 'chat_token';
export const CHAVE_APELIDO = 'chat_apelido';
export const CHAVE_EMAIL = 'chat_email';
/** OAuth client id (tipo Web) do Google Cloud; vazio = botão do Google não aparece (fica o e-mail). */
export const GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';
export const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
export const MAX_TEXTO = 280;
export const APELIDO_RE = /^[\p{L}\p{N}_ ]{2,24}$/u;

export interface Estado {
  online: number;
  aberto: boolean;
  preco_centavos: number;
  mensagens_total: number;
  /** Extensão (salas): online por sala, só salas com gente. */
  salas?: Record<string, number>;
  provedor?: string;
}
export interface Checkout {
  url: string;
  ref: string;
}
export interface Acesso {
  token: string;
  apelido: string;
  email?: string | null;
  expira_em: string;
  autor?: string;
  /** A conta já tem o chat liberado (pagou). */
  pago?: boolean;
}

export interface MsgChat {
  tipo: 'msg';
  id: string;
  autor?: string;
  apelido: string;
  texto: string;
  t: string;
  eu: boolean;
  sala?: string;
}
export interface MsgLote {
  tipo: 'lote';
  itens: Array<(MsgChat | MsgSistema) & { autor?: string; eu?: boolean }>;
}
export interface MsgSistema {
  tipo: 'sistema';
  texto: string;
  t: string;
}
export interface MsgHistorico {
  tipo: 'historico';
  mensagens: MsgChat[];
}
export interface MsgPresenca {
  tipo: 'presenca';
  online: number;
}
export interface MsgErro {
  tipo: 'erro';
  codigo: 'rate_limit' | 'texto_invalido' | 'bloqueado' | string;
  texto: string;
}
export interface MsgReacoes {
  tipo: 'reacoes';
  janela_s: number;
  /** "🔥" | "👏" | … | "torcida:<id>" → contagem na janela. */
  contagem: Record<string, number>;
}
export interface MsgTermometro {
  tipo: 'termometro';
  janela_min: number;
  torcida: Record<string, number>;
  total: number;
}
export interface MsgPong {
  tipo: 'pong';
}
export type MsgServidor = MsgChat | MsgSistema | MsgHistorico | MsgPresenca | MsgErro | MsgReacoes | MsgTermometro | MsgPong | MsgLote;

export const REACOES_EMOJI = ['🔥', '👏', '😱', '😂', '🇧🇷'] as const;
export const MAX_REACOES_S = 5;

export class ChatHttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(`HTTP ${status}: ${detail}`);
  }
}

async function chamar<T>(caminho: string, init?: RequestInit): Promise<T> {
  return chamarUrl<T>(`${CHAT_BASE}${caminho}`, init);
}

async function chamarUrl<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = (await r.json()) as { detail?: unknown };
      if (typeof j.detail === 'string') detail = j.detail;
    } catch {
      /* corpo não-JSON */
    }
    throw new ChatHttpError(r.status, detail);
  }
  return (await r.json()) as T;
}

export const estado = (): Promise<Estado> => chamar<Estado>('/estado', { cache: 'no-cache' });

/** Checkout: com `token` (conta logada) o e-mail é o da conta; sem conta, vai `email`. */
export const checkout = (apelido: string, retorno: string, conta: { token?: string; email?: string }): Promise<Checkout> =>
  chamar<Checkout>('/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(conta.token ? { Authorization: `Bearer ${conta.token}` } : {}) },
    body: JSON.stringify({ apelido, retorno, ...(conta.token ? {} : { email: conta.email }) }),
  });

/** Entrar com Google: troca o ID token do botão por uma sessão (`pago` diz se já tem o chat). */
export const contaGoogle = (credential: string): Promise<Acesso> =>
  chamarUrl<Acesso>(`${CONTA_BASE}/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });

export const acesso = (ref: string): Promise<Acesso> => chamar<Acesso>(`/acesso?ref=${encodeURIComponent(ref)}`, { cache: 'no-store' });

// ------------------------------------------------------------------ conta (quem pagou fica logado)
export interface LoginPedido {
  ok: boolean;
  /** Só em desenvolvimento sem e-mail configurado: o link vem na resposta. */
  link?: string;
}
/** Pede um link de acesso por e-mail (uso único, 30 min). A resposta não revela se o e-mail existe. */
export const pedirLogin = (email: string, retorno: string): Promise<LoginPedido> =>
  chamarUrl<LoginPedido>(`${CONTA_BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, retorno }) });
/** Troca o token do link (?login=) por uma sessão. 410 = link inválido, usado ou vencido. */
export const entrar = (token: string): Promise<Acesso> => chamarUrl<Acesso>(`${CONTA_BASE}/entrar?token=${encodeURIComponent(token)}`, { cache: 'no-store' });

export interface Eu {
  apelido: string;
  email?: string | null;
  expira_em: string;
  pago?: boolean;
}
/** Valida o token sem abrir WebSocket (200 ok · 401 inválido/expirado · outro = servidor fora). */
export const eu = (token: string): Promise<Eu> => chamar<Eu>('/eu', { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });

export interface MsgPrevia {
  apelido: string | null;
  texto: string;
  t: string;
  tipo: 'msg' | 'sistema' | string;
}
export interface Previa {
  sala: string;
  online: number;
  mensagens: MsgPrevia[];
}
/** Prévia pública da sala (últimas 20 mensagens, sem token) para o paywall desfocado. */
export const previa = (sala = 'geral'): Promise<Previa> => chamar<Previa>(`/previa?sala=${encodeURIComponent(sala)}`, { cache: 'no-cache' });

// ------------------------------------------------------------------ sessão local
export interface Sessao {
  token: string;
  apelido: string;
  autor?: string;
  email?: string | null;
  /** false = conta logada (Google) ainda sem os R$ 5. Ausente = desconhecido (sessão antiga). */
  pago?: boolean;
}

export function lerSessao(): Sessao | null {
  try {
    const token = localStorage.getItem(CHAVE_TOKEN);
    const apelido = localStorage.getItem(CHAVE_APELIDO) ?? '';
    const email = localStorage.getItem(CHAVE_EMAIL);
    const pagoRaw = localStorage.getItem('chat_pago');
    return token ? { token, apelido, email, pago: pagoRaw === null ? undefined : pagoRaw === '1' } : null;
  } catch {
    return null;
  }
}

export function guardarSessao(s: Sessao | null): void {
  try {
    if (!s) {
      localStorage.removeItem(CHAVE_TOKEN);
      localStorage.removeItem(CHAVE_APELIDO);
      localStorage.removeItem('chat_autor');
      localStorage.removeItem('chat_pago');
      // o e-mail fica: é só o que a pessoa digitou, e ajuda a entrar de novo
    } else {
      localStorage.setItem(CHAVE_TOKEN, s.token);
      localStorage.setItem(CHAVE_APELIDO, s.apelido);
      if (s.autor) localStorage.setItem('chat_autor', s.autor);
      if (s.email) localStorage.setItem(CHAVE_EMAIL, s.email);
      if (s.pago !== undefined) localStorage.setItem('chat_pago', s.pago ? '1' : '0');
    }
  } catch {
    /* armazenamento indisponível (modo privado etc.) */
  }
}

/** Normaliza como o servidor: espaços repetidos → um; apara pontas. */
export const normalizarApelido = (s: string): string => s.replace(/\s+/g, ' ').trim();
export const apelidoValido = (s: string): boolean => APELIDO_RE.test(normalizarApelido(s));

// ------------------------------------------------------------------ websocket
export type Conexao = 'conectando' | 'aovivo' | 'reconectando' | 'desligado';

export interface SocketOuvintes {
  onConexao: (estado: Conexao, tentativa: number) => void;
  onMensagem: (m: MsgServidor) => void;
  /** Token recusado (4401): a sessão deve ser apagada. */
  onExpirado: () => void;
  /** Sala recusada (4400): o chamador deve voltar à sala geral. */
  onSalaInvalida?: () => void;
  /** Conta válida, mas sem pagamento (4402): mostrar o paywall já logado. */
  onSemPagamento?: () => void;
}

const decoder = new TextDecoder();
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 30_000;
const PING_MS = 25_000;

function urlWs(token: string, sala: string): string {
  const base = new URL(CHAT_BASE, location.href);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = base.pathname.replace(/\/$/, '') + '/ws';
  base.search = `?token=${encodeURIComponent(token)}&sala=${encodeURIComponent(sala)}`;
  return base.toString();
}

export class ChatSocket {
  private ws: WebSocket | null = null;
  private tentativa = 0;
  private timer: number | null = null;
  private ping: number | null = null;
  private fechado = false;
  /** Fechamentos seguidos sem nunca ter aberto (ex.: handshake recusado com 403). */
  private falhasHandshake = 0;

  constructor(
    private token: string,
    private ouvintes: SocketOuvintes,
    /** Sala (docs/CHAT.md › Extensões): 'geral' ou sigla de UF em maiúsculas. */
    readonly sala: string = 'geral',
  ) {
    this.abrir();
    document.addEventListener('visibilitychange', this.aoVisibilidade);
    window.addEventListener('online', this.aoOnline);
  }

  private aoVisibilidade = () => {
    if (document.visibilityState === 'visible' && !this.fechado && this.ws?.readyState !== WebSocket.OPEN) this.reconectarAgora();
  };
  private aoOnline = () => {
    if (!this.fechado) this.reconectarAgora();
  };

  private abrir(): void {
    if (this.fechado) return;
    this.ouvintes.onConexao(this.tentativa === 0 ? 'conectando' : 'reconectando', this.tentativa);
    let ws: WebSocket;
    try {
      ws = new WebSocket(urlWs(this.token, this.sala));
    } catch {
      this.agendar();
      return;
    }
    ws.binaryType = 'arraybuffer'; // o servidor pode mandar JSON em frames binários
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.tentativa = 0;
      this.falhasHandshake = 0;
      this.ouvintes.onConexao('aovivo', 0);
      this.pararPing();
      this.ping = window.setInterval(() => this.enviarBruto({ tipo: 'ping' }), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (ws !== this.ws) return;
      let m: MsgServidor;
      try {
        const bruto = ev.data instanceof ArrayBuffer ? decoder.decode(ev.data) : String(ev.data);
        m = JSON.parse(bruto) as MsgServidor;
      } catch {
        return;
      }
      if (m && typeof m === 'object' && typeof m.tipo === 'string') this.ouvintes.onMensagem(m);
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.pararPing();
      if (this.fechado) return;
      if (ev.code === 4401) {
        this.fechar();
        this.ouvintes.onExpirado();
        return;
      }
      if (ev.code === 4400) {
        this.fechar();
        this.ouvintes.onSalaInvalida?.();
        return;
      }
      if (ev.code === 4402) {
        this.fechar();
        this.ouvintes.onSemPagamento?.();
        return;
      }
      // Handshake recusado repetidamente (servidor fecha antes do accept → 403 → 1006 no
      // navegador): depois de várias tentativas, tratamos como token inválido.
      if (!ev.wasClean && ev.code === 1006 && ++this.falhasHandshake >= 6) {
        this.fechar();
        this.ouvintes.onExpirado();
        return;
      }
      // 4429 (limite excedido): espera o máximo antes de insistir
      if (ev.code === 4429) this.tentativa = Math.max(this.tentativa, 5);
      this.agendar();
    };
    ws.onerror = () => {
      /* onclose segue e trata a reconexão */
    };
  }

  private agendar(): void {
    if (this.fechado || this.timer) return;
    const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.tentativa);
    const espera = base * (0.8 + Math.random() * 0.4); // jitter ±20 %
    this.tentativa++;
    this.ouvintes.onConexao('reconectando', this.tentativa);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.abrir();
    }, espera);
  }

  private reconectarAgora(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      const antigo = this.ws;
      this.ws = null;
      antigo.close();
    }
    this.abrir();
  }

  private pararPing(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  private enviarBruto(obj: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  get aberto(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  enviar(texto: string): boolean {
    return this.enviarBruto({ tipo: 'msg', texto });
  }

  /** Reação (`🔥` … ou `torcida:<id>`); o limite de 5/s é aplicado pelo chamador. */
  enviarReacao(valor: string): boolean {
    return this.enviarBruto({ tipo: 'reacao', valor });
  }

  fechar(): void {
    this.fechado = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pararPing();
    document.removeEventListener('visibilitychange', this.aoVisibilidade);
    window.removeEventListener('online', this.aoOnline);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.ouvintes.onConexao('desligado', 0);
  }
}
