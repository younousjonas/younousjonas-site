// Magasins de données privés (Netlify Blobs), séparés par contexte de déploiement et par mode Stripe.
//
// - Production : deux magasins de site.
//     bd-interets-production            demandes d'intérêt ; indépendant du mode Stripe, il survit
//                                        tel quel à la bascule test → live (aucune migration).
//     bd-commandes-production-<mode>     commandes, jetons, sessions, file d'envoi ; un magasin par
//                                        mode Stripe (test, live) : un paiement de test ne touche
//                                        jamais les commandes réelles.
// - Tout autre contexte (deploy-preview, branch-deploy, dev, inconnu) : un magasin de déploiement
//   (getDeployStore), visible de ce seul déploiement. Un aperçu n'ouvre jamais un magasin de production.
//
// En test : magasin en mémoire.

// Clés qui relèvent du magasin des demandes d'intérêt.
export function estCleInteret(k){ return k.startsWith('interets/') || k.startsWith('rl/interet-'); }

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

function adapter(s){
  return {
    async getJSON(k){ return (await s.get(k, { type: 'json' })) ?? null; },
    async setJSON(k, v){ await s.setJSON(k, v); },
    async delete(k){ await s.delete(k); },
    async list(prefixe){ const r = await s.list({ prefix: prefixe }); return (r.blobs || []).map((b) => b.key).sort(); },
  };
}

// Aiguillage par préfixe de clé entre le magasin des intérêts et celui des commandes.
export function magasinAiguille(interets, commandes){
  const pour = (k) => (estCleInteret(k) ? interets : commandes);
  return {
    async getJSON(k){ return pour(k).getJSON(k); },
    async setJSON(k, v){ return pour(k).setJSON(k, v); },
    async delete(k){ return pour(k).delete(k); },
    async list(p){ return pour(p).list(p); },
  };
}

// Contexte de déploiement : celui fourni par Netlify à la fonction, sinon CONTEXT.
export function contexteDeploiement(context, env = process.env){
  return (context && context.deploy && context.deploy.context) || env.CONTEXT || 'inconnu';
}

// Noms des magasins pour un contexte et un mode donnés (testé sans Netlify).
export function plan(contexte, mode){
  if(contexte === 'production'){
    return { type: 'site', interets: 'bd-interets-production', commandes: `bd-commandes-production-${mode === 'live' ? 'live' : 'test'}` };
  }
  return { type: 'deploiement', interets: 'bd-apercu', commandes: 'bd-apercu' };
}

export async function magasinNetlify(context, mode){
  const p = plan(contexteDeploiement(context), mode);
  const { getStore, getDeployStore } = await import('@netlify/blobs');
  if(p.type === 'site'){
    return magasinAiguille(adapter(getStore({ name: p.interets, consistency: 'strong' })), adapter(getStore({ name: p.commandes, consistency: 'strong' })));
  }
  const s = adapter(getDeployStore({ name: p.commandes, consistency: 'strong' }));
  return magasinAiguille(s, s);
}
