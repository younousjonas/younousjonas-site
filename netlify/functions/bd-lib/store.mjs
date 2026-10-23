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
// Atomicité : les modifications concurrentes passent par des écritures conditionnelles
// (onlyIfNew, onlyIfMatch sur l'ETag). La cohérence forte seule ne suffit pas et n'est pas
// présentée comme une garantie. Si l'écriture conditionnelle n'est pas confirmée par la
// bibliothèque, on échoue (« ecriture_conditionnelle_non_supportee ») plutôt que d'écrire sans garde.
//
// Interface d'un magasin :
//   getJSON(k) → valeur | null           getJSONv(k) → { valeur, etag } | null
//   setJSON(k, v)  (sans condition)      setJSONsi(k, v, { nouveau: true } | { etag }) → { ok, etag }
//   delete(k)                            list(prefixe) → [clés]

export function estCleInteret(k){ return k.startsWith('interets/') || k.startsWith('rl/interet-'); }

// Magasin en mémoire, pour les tests : ETag par clé, latence optionnelle (pour entrelacer
// de vraies opérations concurrentes) et pannes injectées (panne(op, cle) peut lever une erreur).
export function magasinMemoire({ latence = 0, panne = null } = {}){
  const m = new Map(); let n = 0;
  const pause = () => (latence ? new Promise((r) => setTimeout(r, latence)) : Promise.resolve());
  const verifier = (op, k) => { if(panne) panne(op, k); };
  return {
    _map: m,
    async getJSON(k){ await pause(); const e = m.get(k); return e ? JSON.parse(e.v) : null; },
    async getJSONv(k){ await pause(); const e = m.get(k); return e ? { valeur: JSON.parse(e.v), etag: e.etag } : null; },
    async setJSON(k, v){ await pause(); verifier('set', k); n += 1; m.set(k, { v: JSON.stringify(v), etag: 'e' + n }); },
    async setJSONsi(k, v, cond){
      await pause(); verifier('set', k);
      const e = m.get(k);
      if(cond && cond.nouveau && e) return { ok: false };
      if(cond && cond.etag && (!e || e.etag !== cond.etag)) return { ok: false };
      n += 1; const etag = 'e' + n; m.set(k, { v: JSON.stringify(v), etag });
      return { ok: true, etag };
    },
    async delete(k){ await pause(); verifier('delete', k); m.delete(k); },
    async list(prefixe){ await pause(); return [...m.keys()].filter((k) => k.startsWith(prefixe)).sort(); },
  };
}

// Adaptateur d'un magasin Netlify Blobs (exporté pour les tests).
export function adapter(s){
  const etagValide = (etag) => typeof etag === 'string' && etag.trim().length > 0;
  const ecrire = async (k, v, options) => {
    // set() avec une chaîne : les conditions sont transmises telles quelles (setJSON en 10.x a été
    // signalé comme ne les transmettant pas).
    const r = await s.set(k, JSON.stringify(v), options);
    if(!r || typeof r.modified !== 'boolean') throw new Error('ecriture_conditionnelle_non_supportee');
    // Certaines versions du SDK annoncent modified:true avec un ETag vide sur un échec HTTP.
    // Sans ETag de succès, l'écriture n'est pas confirmée : on échoue au lieu d'avancer le traitement.
    // Source : https://github.com/netlify/primitives/issues/741
    if(r.modified && !etagValide(r.etag)) throw new Error('ecriture_conditionnelle_non_confirmee');
    return { ok: r.modified, etag: r.etag };
  };
  return {
    async getJSON(k){ return (await s.get(k, { type: 'json' })) ?? null; },
    async getJSONv(k){
      const r = await s.getWithMetadata(k, { type: 'json' });
      if(r === null) return null;
      if(!r || !etagValide(r.etag)) throw new Error('etag_lecture_absent');
      return { valeur: r.data, etag: r.etag };
    },
    async setJSON(k, v){ await s.set(k, JSON.stringify(v)); },
    async setJSONsi(k, v, cond){
      const creation = cond && Object.hasOwn(cond, 'nouveau') && cond.nouveau === true && !Object.hasOwn(cond, 'etag');
      const modification = cond && !Object.hasOwn(cond, 'nouveau') && Object.hasOwn(cond, 'etag') && etagValide(cond.etag);
      // onlyIfMatch vide est ignoré par le SDK : ne jamais le laisser devenir une écriture sans condition.
      if(!creation && !modification) throw new Error('condition_ecriture_invalide');
      return ecrire(k, v, creation ? { onlyIfNew: true } : { onlyIfMatch: cond.etag });
    },
    async delete(k){ await s.delete(k); },
    async list(prefixe){ const r = await s.list({ prefix: prefixe }); return (r.blobs || []).map((b) => b.key).sort(); },
  };
}

// Aiguillage par préfixe de clé entre le magasin des intérêts et celui des commandes.
export function magasinAiguille(interets, commandes){
  const pour = (k) => (estCleInteret(k) ? interets : commandes);
  return {
    async getJSON(k){ return pour(k).getJSON(k); },
    async getJSONv(k){ return pour(k).getJSONv(k); },
    async setJSON(k, v){ return pour(k).setJSON(k, v); },
    async setJSONsi(k, v, c){ return pour(k).setJSONsi(k, v, c); },
    async delete(k){ return pour(k).delete(k); },
    async list(p){ return pour(p).list(p); },
  };
}

// ---------- primitives atomiques ----------

// Crée la clé seulement si elle n'existe pas. Renvoie true si créée.
export async function creerSiNouveau(store, k, v){ return (await store.setJSONsi(k, v, { nouveau: true })).ok; }

// Lecture-modification-écriture conditionnelle. fn(valeur courante, ou null) renvoie la nouvelle
// valeur, ou undefined pour ne rien écrire. Relit et rejoue en cas de conflit ; au-delà de
// `essais`, échoue (« conflit_ecriture ») : jamais d'écriture sans garde.
// fn peut être rejouée : elle ne doit avoir d'effet que sur la valeur qu'elle renvoie.
export async function maj(store, k, fn, essais = 10){
  for(let i = 0; i < essais; i++){
    const cur = await store.getJSONv(k);
    const avant = cur ? cur.valeur : null;
    const apres = await fn(avant === null ? null : structuredClone(avant));
    if(apres === undefined) return { valeur: avant, ecrit: false };
    const r = await store.setJSONsi(k, apres, cur ? { etag: cur.etag } : { nouveau: true });
    if(r.ok) return { valeur: apres, ecrit: true };
    // Conflit : courte attente aléatoire et croissante avant de relire.
    await new Promise((ok) => setTimeout(ok, Math.random() * Math.min(200, 5 * 2 ** i)));
  }
  throw new Error('conflit_ecriture');
}

// ---------- plan des magasins ----------

export function contexteDeploiement(context, env = process.env){
  return (context && context.deploy && context.deploy.context) || env.CONTEXT || 'inconnu';
}

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
