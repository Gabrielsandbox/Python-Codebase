/* Service worker da Apuração 2026 (docs/ALERTAS.md).
   - push: mostra a notificação { title, body, url, tag } enviada pelo serviço de alertas;
   - notificationclick: foca uma aba do site ou abre `url`;
   - fetch: cache-first só para /geo/* e /ref/* (estáticos versionados por conteúdo).
     Nunca intercepta /dados, /chat ou /alertas. */
const CACHE = 'apuracao-estaticos-v1';
const CACHEAVEL = /\/(geo|ref)\/[^?]+\.(json|topojson)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches
      .keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !CACHEAVEL.test(url.pathname)) return;
  ev.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const resp = await fetch(req);
      if (resp.ok) cache.put(req, resp.clone());
      return resp;
    }),
  );
});

self.addEventListener('push', (ev) => {
  let dados = {};
  try {
    dados = ev.data ? ev.data.json() : {};
  } catch {
    dados = { body: ev.data ? ev.data.text() : '' };
  }
  const title = dados.title || 'Apuração 2026';
  const url = dados.url || self.registration.scope;
  ev.waitUntil(
    self.registration.showNotification(title, {
      body: dados.body || '',
      tag: dados.tag || 'apuracao',
      renotify: !!dados.tag,
      icon: new URL('icons/icon-192.png', self.registration.scope).href,
      badge: new URL('icons/badge-96.png', self.registration.scope).href,
      lang: 'pt-BR',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  const url = (ev.notification.data && ev.notification.data.url) || self.registration.scope;
  ev.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      const alvo = new URL(url, self.location.origin);
      for (const c of lista) {
        if (new URL(c.url).origin === alvo.origin && 'focus' in c) {
          if ('navigate' in c && new URL(c.url).pathname !== alvo.pathname) c.navigate(alvo.href);
          return c.focus();
        }
      }
      return self.clients.openWindow(alvo.href);
    }),
  );
});
