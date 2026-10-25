// Cloudflare Web Analytics (gratuito, sem cookies): conta só navegadores reais, não robôs.
// Liga quando VITE_CF_BEACON (token do site em Analytics → Web Analytics) está definido.
const token = (import.meta.env.VITE_CF_BEACON as string | undefined)?.trim();
if (token && import.meta.env.PROD) {
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.dataset.cfBeacon = JSON.stringify({ token });
  document.head.append(s);
}
