/* Checkout intégré. Stripe recueille les coordonnées et les données bancaires. */
(() => {
  'use strict';
  const button = document.getElementById('bilan-pay');
  if (!button) return;
  const panel = document.getElementById('bilan-payment');
  const status = document.getElementById('bilan-payment-status');
  const result = document.getElementById('bilan-payment-result');
  const mount = document.getElementById('bilan-checkout');
  const retry = document.getElementById('bilan-payment-retry');
  const endpoint = '/.netlify/functions/bilan-2026-paiement';
  const storageKey = 'bilan-2026-checkout';
  let checkout, busy = false, cache, stripeLoading;
  try { cache = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch (_) {}
  const save = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(cache)); } catch (_) {} };
  const forget = () => { cache = null; try { sessionStorage.removeItem(storageKey); } catch (_) {} };
  const show = message => {
    panel.hidden = false; status.textContent = message;
    panel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  };
  async function request(url, options) {
    const r = await fetch(url, { cache: 'no-store', ...options });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Le paiement est momentanément indisponible. Réessaie dans quelques instants.');
    return data;
  }
  function loadStripe() {
    if (window.Stripe) return Promise.resolve();
    if (!stripeLoading) stripeLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.onload = () => window.Stripe ? resolve() : reject(new Error('Le formulaire de paiement ne peut pas être chargé.'));
      script.onerror = () => { script.remove(); stripeLoading = null; reject(new Error('Le formulaire de paiement ne peut pas être chargé. Vérifie ta connexion, puis réessaie.')); };
      document.head.appendChild(script);
    });
    return stripeLoading;
  }
  async function verify(id) {
    const state = await request(endpoint + '?session_id=' + encodeURIComponent(id));
    if (state.payment_status === 'paid') {
      if (checkout) { checkout.destroy(); checkout = null; }
      mount.hidden = true; retry.hidden = true; button.hidden = true;
      result.hidden = false; status.textContent = 'Paiement confirmé · 397 €';
      forget();
      // La référence n'est pas transmise aux liens extérieurs ni conservée dans l'URL.
      const url = new URL(location.href); url.searchParams.delete('session_id');
      history.replaceState(null, '', url.pathname + url.search + '#reservation');
      return 'paid';
    }
    if (state.status === 'complete') {
      if (checkout) { checkout.destroy(); checkout = null; }
      mount.hidden = true; status.textContent = 'Ton règlement est en cours de confirmation par la banque. Aucun nouveau paiement n’est nécessaire.';
      retry.hidden = false; retry.textContent = 'Vérifier mon règlement';
      retry.onclick = () => checkReturn(id);
      return 'pending';
    }
    return state.status;
  }
  async function checkReturn(id) {
    show('Vérification de ton règlement…');
    try {
      const state = await verify(id);
      if (state === 'open') {
        if (cache?.id === id && cache.clientSecret) { busy = false; await open(); }
        else {
          status.textContent = 'Le règlement n’est pas terminé. Tu peux reprendre ton inscription.';
          forget(); retry.hidden = false; retry.textContent = 'Reprendre mon inscription'; retry.onclick = open;
        }
      } else if (state === 'expired') {
        forget(); status.textContent = 'Cette session de paiement a expiré.';
        retry.hidden = Date.now() >= Date.parse('2026-11-02T00:00:00+04:00');
        retry.textContent = 'Reprendre mon inscription'; retry.onclick = open;
      }
    } catch (e) {
      status.textContent = e.message + ' Si tu as déjà réglé, ne paie pas une seconde fois : contacte Younous.';
      retry.hidden = false; retry.textContent = 'Vérifier à nouveau'; retry.onclick = () => checkReturn(id);
    }
  }
  async function open(event) {
    if (event) event.preventDefault();
    if (busy) return;
    if (checkout) { show('Ton règlement sécurisé'); return; }
    busy = true; button.disabled = true; retry.hidden = true;
    show('Préparation de ton règlement sécurisé…');
    try {
      if (cache?.id) {
        const state = await verify(cache.id);
        if (state === 'paid' || state === 'pending') return;
        if (state === 'expired') forget();
      }
      if (!cache?.clientSecret) {
        if (!cache || cache.started_at < Date.now() - 3600e3) {
          cache = { request_id: crypto.randomUUID(), started_at: Date.now() };
          const params = new URLSearchParams(location.search);
          ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => {
            const value = params.get(k); if (/^[A-Za-z0-9_-]{1,120}$/.test(value || '')) cache[k] = value;
          });
          save();
        }
        const session = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cache) });
        cache = { ...cache, ...session }; save();
      }
      await loadStripe();
      const stripe = window.Stripe(cache.publishableKey);
      const create = stripe.createEmbeddedCheckoutPage || stripe.initEmbeddedCheckout;
      if (!create) throw new Error('Le formulaire de paiement ne peut pas être chargé.');
      const id = cache.id;
      checkout = await create.call(stripe, { fetchClientSecret: () => Promise.resolve(cache.clientSecret),
        onComplete: () => checkReturn(id) });
      mount.hidden = false; checkout.mount('#bilan-checkout');
      status.textContent = 'Ton règlement sécurisé · 397 €';
    } catch (e) {
      status.textContent = e.message;
      retry.hidden = false; retry.textContent = 'Réessayer'; retry.onclick = open;
    } finally { busy = false; button.disabled = false; }
  }
  button.addEventListener('click', open);
  const returned = new URLSearchParams(location.search).get('session_id');
  if (returned) checkReturn(returned);
  else if (cache?.id) checkReturn(cache.id);
})();
