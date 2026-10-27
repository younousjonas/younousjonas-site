import test from 'node:test';
import assert from 'node:assert/strict';
import { responseFor } from '../netlify/functions/bilan-2026-checkout.mjs';
const end = Date.parse('2026-11-02T00:00:00+04:00');
test('ouvert jusqu’à la dernière milliseconde du 1er novembre Réunion', () => { const r=responseFor('GET',{},end-1); assert.equal(r.statusCode,303); assert.equal(r.headers.Location,'https://book.stripe.com/8x2fZgbFRbM11DVerQ8ww2t'); });
test('fermeture à minuit Réunion et non à minuit du navigateur', () => { for (const now of [end,end+86400000]) assert.equal(responseFor('GET',{},now).headers.Location,'/bilan-2026?offre=terminee#reservation'); assert.equal(new Date(end).toISOString(),'2026-11-01T20:00:00.000Z'); });
test('seuls les paramètres de campagne autorisés sont transmis',()=>{const r=responseFor('GET',{utm_source:'instagram',utm_campaign:'bilan_2026',email:'personne@example.com',redirect:'https://evil.example',utm_content:'a<script>'},end-1);const u=new URL(r.headers.Location);assert.equal(u.hostname,'book.stripe.com');assert.equal(u.searchParams.get('utm_source'),'instagram');assert.equal(u.searchParams.get('utm_campaign'),'bilan_2026');assert.equal(u.searchParams.size,2);});
test('pas de cache ni indexation du point de paiement',()=>{for(const now of [end-1,end]){const r=responseFor('GET',{},now);assert.equal(r.headers['Cache-Control'],'no-store, max-age=0');assert.equal(r.headers['X-Robots-Tag'],'noindex, nofollow');}});
test('méthodes non attendues refusées ; HEAD et date invalide contrôlés',()=>{assert.equal(responseFor('POST',{},end-1).statusCode,405);assert.equal(responseFor('HEAD',{},end-1).statusCode,303);assert.match(responseFor('GET',{},NaN).headers.Location,/terminee/);});
