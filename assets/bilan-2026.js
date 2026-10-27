/* Échéance et paramètres de campagne. Aucun cookie, aucun traceur. */
(() => {
  'use strict';
  const end = Date.parse('2026-11-02T00:00:00+04:00');
  const pageURL = new URL(document.baseURI);
  const params = pageURL.searchParams;
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  function update() {
    const closed = Date.now() >= end || params.get('offre') === 'terminee';
    document.querySelectorAll('[data-bilan-open]').forEach(el => { el.hidden = closed; });
    document.querySelectorAll('[data-bilan-closed]').forEach(el => { el.hidden = !closed; });
    if (closed) {
      document.querySelectorAll('[data-bilan-checkout]').forEach(el => { el.removeAttribute('href'); el.setAttribute('aria-disabled', 'true'); });
      const schema = document.getElementById('page-schema');
      if (schema) { try { const data = JSON.parse(schema.textContent); (data['@graph'] || []).forEach(item => { if (item['@type'] === 'Service') delete item.offers; }); schema.textContent = JSON.stringify(data); } catch (_) {} }
    }
    return closed;
  }
  document.querySelectorAll('[data-bilan-checkout],[data-bilan-detail]').forEach(link => {
    const url = new URL(link.getAttribute('href'), pageURL);
    keys.forEach(key => { const value = params.get(key); if (value && /^[A-Za-z0-9_-]{1,120}$/.test(value)) url.searchParams.set(key, value); });
    link.href = url.pathname + url.search + url.hash;
    if (link.hasAttribute('data-bilan-checkout')) link.addEventListener('click', event => { if (update()) event.preventDefault(); });
  });
  update(); setInterval(update, 30000);
})();
