// Régressions de l'adaptateur Netlify : uniquement des magasins simulés, aucun réseau.
// Les écritures conditionnelles ne doivent jamais devenir inconditionnelles ni annoncer
// un succès sur la réponse { modified: true, etag: '' } du défaut SDK netlify/primitives#741.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter, maj } from '../netlify/functions/bd-lib/store.mjs';

const ETAG = '"version-1"';

test('lecture versionnée : une entrée sans ETag valide est refusée', async () => {
  for(const etag of [undefined, null, '', '   ', 123, false]){
    const store = adapter({ async getWithMetadata(){ return { data: { n: 1 }, etag }; } });
    await assert.rejects(() => store.getJSONv('commande'), /etag_lecture_absent/);
  }
});

test('lecture versionnée : absence réelle et entrée avec ETag restent distinctes', async () => {
  const absent = adapter({ async getWithMetadata(){ return null; } });
  assert.equal(await absent.getJSONv('absente'), null);
  const present = adapter({ async getWithMetadata(){ return { data: { n: 1 }, etag: ETAG }; } });
  assert.deepEqual(await present.getJSONv('commande'), { valeur: { n: 1 }, etag: ETAG });
});

test('écriture conditionnelle : condition absente, vide, ambiguë ou mal typée refusée avant le SDK', async () => {
  let appels = 0;
  const store = adapter({ async set(){ appels += 1; return { modified: true, etag: ETAG }; } });
  const invalides = [
    undefined, null, {}, { etag: undefined }, { etag: null }, { etag: '' }, { etag: '   ' },
    { etag: 123 }, { nouveau: false }, { nouveau: 'true' }, { nouveau: 1 },
    { nouveau: true, etag: ETAG }, { nouveau: true, etag: undefined }, { nouveau: false, etag: ETAG },
  ];
  for(const condition of invalides){
    await assert.rejects(() => store.setJSONsi('commande', { n: 2 }, condition), /condition_ecriture_invalide/);
  }
  assert.equal(appels, 0, 'aucune condition invalide ne doit atteindre s.set');
});

test('écriture conditionnelle : création et modification transmettent leur garde intacte', async () => {
  const appels = [];
  const store = adapter({ async set(k, v, options){ appels.push({ k, v, options }); return { modified: true, etag: '"version-2"' }; } });
  assert.deepEqual(await store.setJSONsi('nouvelle', { n: 1 }, { nouveau: true }), { ok: true, etag: '"version-2"' });
  assert.deepEqual(await store.setJSONsi('commande', { n: 2 }, { etag: ETAG }), { ok: true, etag: '"version-2"' });
  assert.deepEqual(appels, [
    { k: 'nouvelle', v: '{"n":1}', options: { onlyIfNew: true } },
    { k: 'commande', v: '{"n":2}', options: { onlyIfMatch: ETAG } },
  ]);
});

test('écriture conditionnelle : succès annoncé sans ETag valide refusé pour les deux conditions', async () => {
  for(const etag of [undefined, null, '', '   ', 123]){
    for(const condition of [{ nouveau: true }, { etag: ETAG }]){
      const store = adapter({ async set(){ return { modified: true, etag }; } });
      await assert.rejects(() => store.setJSONsi('commande', { n: 2 }, condition), /ecriture_conditionnelle_non_confirmee/);
    }
  }
});

test('écriture conditionnelle : modified:false sans ETag reste un conflit normal', async () => {
  const store = adapter({ async set(){ return { modified: false }; } });
  for(const condition of [{ nouveau: true }, { etag: ETAG }]){
    assert.deepEqual(await store.setJSONsi('commande', { n: 2 }, condition), { ok: false, etag: undefined });
  }
});

test('mise à jour : une lecture sans ETag ne devient jamais une écriture sans condition', async () => {
  let appels = 0;
  const store = adapter({
    async getWithMetadata(){ return { data: { n: 1 } }; },
    async set(){ appels += 1; return { modified: true, etag: '' }; },
  });
  await assert.rejects(() => maj(store, 'commande', (v) => ({ n: v.n + 1 })), /etag_lecture_absent/);
  assert.equal(appels, 0);
});
