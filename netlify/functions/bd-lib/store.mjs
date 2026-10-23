// Magasin de données privé. En production : Netlify Blobs (magasin « bd-biographies »,
// cohérence forte), invisible du site public. En test : magasin en mémoire.

export function magasinMemoire(){
  const m = new Map();
  return {
    _map: m,
    async getJSON(k){ return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v){ m.set(k, JSON.stringify(v)); },
    async delete(k){ m.delete(k); },
    async list(prefixe){ return [...m.keys()].filter((k) => k.startsWith(prefixe)).sort(); },
  };
}

let magasinProd = null;
export async function magasinNetlify(){
  if(magasinProd) return magasinProd;
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name: 'bd-biographies', consistency: 'strong' });
  magasinProd = {
    async getJSON(k){ return (await s.get(k, { type: 'json' })) ?? null; },
    async setJSON(k, v){ await s.setJSON(k, v); },
    async delete(k){ await s.delete(k); },
    async list(prefixe){
      const r = await s.list({ prefix: prefixe });
      return (r.blobs || []).map((b) => b.key).sort();
    },
  };
  return magasinProd;
}
