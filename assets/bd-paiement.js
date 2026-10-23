/* Paiement intégré des albums « BD personnelle » (Stripe Embedded Checkout).
   - /paiement-bd#t=… : le lien personnel de paiement est dans le fragment d'URL
     (jamais envoyé dans l'URL au serveur, jamais en Referer) ; il est retiré aussitôt.
   - /paiement-bd-retour?session_id=… : la page ne déclare jamais un succès d'elle-même ;
     elle interroge le serveur, qui ne répond « payé » qu'après le webhook Stripe signé.
   Stripe.js n'est chargé que si le paiement est réellement ouvert. */
(function(){
  'use strict';
  var API = '/.netlify/functions/bd-paiement';
  function $(id){ return document.getElementById(id); }
  function montrer(id, ids){ ids.forEach(function(x){ var n = $(x); if(n) n.hidden = (x !== id); }); }
  function appel(corps){
    return fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify(corps) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(b){ return { r:r, b:b }; }); });
  }
  function chargerStripe(){
    return new Promise(function(ok, ko){
      if(window.Stripe) return ok();
      var s = document.createElement('script'); s.src = 'https://js.stripe.com/v3/'; s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    });
  }

  function pagePaiement(){
    var ETATS = ['bdp-chargement','bdp-invalide','bdp-deja','bdp-resume'];
    var m = location.hash.match(/^#t=([A-Za-z0-9_-]{43})$/);
    var jeton = m ? m[1] : null;
    try{ if(jeton) sessionStorage.setItem('bdp-t', jeton); else jeton = sessionStorage.getItem('bdp-t'); }catch(e){}
    if(location.hash) history.replaceState(null, '', location.pathname);
    if(!jeton){ montrer('bdp-invalide', ETATS); return; }
    appel({ action:'resume', jeton: jeton }).then(function(x){
      if(!x.r.ok){ montrer('bdp-invalide', ETATS); return; }
      if(x.b.dejaPaye){ montrer('bdp-deja', ETATS); return; }
      $('bdp-libelle').textContent = x.b.libelle; $('bdp-ref').textContent = x.b.reference;
      $('bdp-prenom').textContent = x.b.prenom; $('bdp-montant').textContent = x.b.montant;
      montrer('bdp-resume', ETATS);
      if(!x.b.paiementDisponible){ $('bdp-indisponible').hidden = false; return; }
      var statut = $('bdp-status');
      appel({ action:'session', jeton: jeton }).then(function(y){
        if(!y.r.ok){ statut.className = 'bdq-status error'; statut.textContent = y.b.message || 'Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.'; if(y.r.status === 503) $('bdp-indisponible').hidden = false; return; }
        return chargerStripe().then(function(){
          var stripe = window.Stripe(y.b.publishableKey);
          // Méthode actuelle, puis l'ancienne si la version de Stripe.js ne la connaît pas.
          var creer = stripe.createEmbeddedCheckoutPage || stripe.initEmbeddedCheckout;
          return Promise.resolve(creer.call(stripe, { fetchClientSecret: function(){ return Promise.resolve(y.b.clientSecret); } }))
            .then(function(checkout){ checkout.mount('#bdp-checkout'); });
        });
      }).catch(function(){ statut.className = 'bdq-status error'; statut.textContent = 'Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.'; });
    }).catch(function(){ montrer('bdp-invalide', ETATS); });
  }

  function pageRetour(){
    var ETATS = ['bdp-attente','bdp-inconnu','bdp-confirme'];
    var sid = new URLSearchParams(location.search).get('session_id') || '';
    if(location.search) history.replaceState(null, '', location.pathname);   // l'identifiant ne reste pas dans l'historique
    var essais = 0;
    function sonder(){
      essais += 1;
      appel({ action:'statut', sessionId: sid }).then(function(x){
        var b = x.b || {};
        if(b.statut === 'paye'){
          $('bdp-c-prenom').textContent = b.prenom; $('bdp-c-offre').textContent = b.libelle;
          $('bdp-c-montant').textContent = b.montant; $('bdp-c-ref').textContent = b.reference; $('bdp-c-etape').textContent = 'Prochaine étape : ' + b.etape;
          $(b.acces ? 'bdp-c-acces' : 'bdp-c-sans-acces').hidden = false;
          montrer('bdp-confirme', ETATS); return;
        }
        if(b.statut === 'inconnu' && essais > 3){ montrer('bdp-inconnu', ETATS); return; }
        if(essais < 30) setTimeout(sonder, 2000);
        else $('bdp-attente-texte').textContent = 'La confirmation prend plus de temps que prévu. Votre lien personnel vous sera transmis dès qu’elle arrive ; vous pouvez fermer cette page.';
      }).catch(function(){ if(essais < 30) setTimeout(sonder, 3000); });
    }
    sonder();
  }

  function start(){
    var nojs = $('bdq-nojs'); if(nojs) nojs.remove();
    if(document.body.getAttribute('data-page') === 'paiement-bd-retour') pageRetour(); else pagePaiement();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
