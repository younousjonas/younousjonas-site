/* Retour de paiement des albums « BD personnelle » (/paiement-bd-retour?session_id=…).
   La page ne déclare jamais un succès d'elle-même : elle interroge le serveur, qui ne
   répond « payé » qu'après le webhook Stripe signé. Le paiement lui-même se fait sur
   /achat-bd (assets/bd-achat.js). */
(function(){
  'use strict';
  var API = '/.netlify/functions/bd-paiement';
  function $(id){ return document.getElementById(id); }
  function montrer(id, ids){ ids.forEach(function(x){ var n = $(x); if(n) n.hidden = (x !== id); }); }
  function appel(corps){
    return fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify(corps) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(b){ return { r:r, b:b }; }); });
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
    pageRetour();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
