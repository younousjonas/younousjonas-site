/* Achat direct des albums « BD personnelle » : coordonnées minimales, puis Stripe Embedded
   Checkout sur la même page. Le prix et l'offre viennent du serveur (fonction bd-achat).
   - Paiement fermé : la page le dit et n'affiche aucun formulaire ; rien n'est envoyé.
   - Une clé d'achat aléatoire est tirée au chargement : un double clic ou un nouvel essai
     désigne la même commande et la même session de paiement.
   Stripe.js n'est chargé que si le paiement est réellement ouvert. Aucun suivi, aucun tiers. */
(function(){
  'use strict';
  var API = '/.netlify/functions/bd-achat';
  var form, errors, status, offre = null, cle = null, envoiEnCours = false;
  var LIBELLES = {
    offre: 'L’album choisi', prenoms: 'Votre ou vos prénoms', nom: 'Votre nom',
    email: 'Une adresse électronique valide', whatsapp: 'Un numéro WhatsApp avec l’indicatif du pays (par exemple +262…)',
    declarationWhatsapp: 'La confirmation que ce numéro est joignable sur WhatsApp', consentement: 'Votre accord pour traiter la commande',
    cle: 'Rechargez la page pour recommencer'
  };
  var ZONES = { prenoms:'bda-q-prenoms', nom:'bda-q-nom', email:'bda-q-email', whatsapp:'bda-q-whatsapp', declarationWhatsapp:'bda-q-whatsapp', consentement:'bda-q-consentement' };
  function $(id){ return document.getElementById(id); }

  function nouvelleCle(){
    var b = new Uint8Array(24); window.crypto.getRandomValues(b);
    var s = ''; for(var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function chargerStripe(){
    return new Promise(function(ok, ko){
      if(window.Stripe) return ok();
      var s = document.createElement('script'); s.src = 'https://js.stripe.com/v3/'; s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    });
  }
  function valeurs(){
    return {
      action: 'commander', offre: offre, cle: cle,
      prenoms: form.prenoms.value.trim(), nom: form.nom.value.trim(), email: form.email.value.trim(),
      whatsapp: form.whatsapp.value.trim(), declarationWhatsapp: form.declarationWhatsapp.checked,
      consentement: form.consentement.checked, siteweb: form.siteweb.value
    };
  }
  function whatsappOk(t){ var s = t.replace(/[\s.\-()]/g, ''); if(s.indexOf('00') === 0) s = '+' + s.slice(2); return /^\+[1-9]\d{7,14}$/.test(s); }
  function verifier(v){
    var m = [];
    if(!v.prenoms) m.push('prenoms'); if(!v.nom) m.push('nom');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) m.push('email');
    if(!whatsappOk(v.whatsapp)) m.push('whatsapp'); if(!v.declarationWhatsapp) m.push('declarationWhatsapp');
    if(!v.consentement) m.push('consentement');
    return m;
  }
  function montrer(champs){
    document.querySelectorAll('.bdq-q.error').forEach(function(b){ b.classList.remove('error'); });
    errors.innerHTML = '';
    errors.appendChild(document.createTextNode('Il manque quelques informations :'));
    var ul = document.createElement('ul');
    champs.forEach(function(c){
      var z = $(ZONES[c]); if(z) z.classList.add('error');
      var li = document.createElement('li'); li.textContent = LIBELLES[c] || c; ul.appendChild(li);
    });
    errors.appendChild(ul); errors.classList.add('visible'); errors.focus();
  }
  function erreur(texte){ status.className = 'bdq-status error'; status.textContent = texte; }

  function monterPaiement(b){
    $('bda-ref').textContent = b.reference || ''; $('bda-prenom').textContent = b.prenom || '';
    return chargerStripe().then(function(){
      var stripe = window.Stripe(b.publishableKey);
      // Méthode actuelle, puis l'ancienne si la version de Stripe.js ne la connaît pas.
      var creer = stripe.createEmbeddedCheckoutPage || stripe.initEmbeddedCheckout;
      return Promise.resolve(creer.call(stripe, { fetchClientSecret: function(){ return Promise.resolve(b.clientSecret); } }))
        .then(function(checkout){
          form.hidden = true; $('bda-q-offre').hidden = true; $('bda-paiement').hidden = false;
          checkout.mount('#bda-checkout'); window.scrollTo(0, 0);
        });
    });
  }

  function envoyer(e){
    e.preventDefault();
    if(envoiEnCours) return;                       // double clic : un seul envoi à la fois
    var v = valeurs(); var m = verifier(v);
    if(m.length){ montrer(m); return; }
    errors.classList.remove('visible');
    envoiEnCours = true;
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    status.className = 'bdq-status'; status.textContent = 'Préparation du paiement…';
    var fin = function(){ envoiEnCours = false; btn.disabled = false; };
    fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(v), credentials:'same-origin' })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(b){ return { r:r, b:b }; }); })
      .then(function(x){
        if(x.r.status === 200){ status.textContent = ''; return monterPaiement(x.b).catch(function(){ fin(); erreur('Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.'); }); }
        fin();
        if(x.r.status === 422 && x.b.champs){ status.textContent = ''; montrer(x.b.champs); return; }
        if(x.r.status === 503){ afficherFerme(); return; }
        if(x.r.status === 409 && x.b.erreur === 'deja_paye'){ erreur('Cette commande est déjà réglée. Votre lien personnel vous est transmis ; vous pouvez aussi ouvrir votre espace pour en demander un.'); return; }
        if(x.r.status === 409){ cle = nouvelleCle(); erreur('Cette page a expiré. Vérifiez vos informations et cliquez de nouveau.'); return; }
        erreur(x.r.status === 429 ? 'Trop d’essais depuis cette connexion. Réessayez dans une heure, ou écrivez à younousjonas@gmail.com.' : (x.b.message || 'Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.'));
      })
      .catch(function(){ fin(); erreur('Le paiement n’a pas pu s’ouvrir. Réessayez dans un moment.'); });
  }

  function afficherFerme(){ form.hidden = true; $('bda-ferme').hidden = false; }

  function choisir(code){
    if(offre !== code) cle = nouvelleCle();         // une clé d'achat par offre
    offre = code;
    var r = document.querySelector('input[name=offre][value="' + code + '"]'); if(r) r.checked = true;
    var u = new URL(location.href); u.searchParams.set('offre', code); history.replaceState(null, '', u.pathname + u.search);
    return fetch(API + '?offre=' + encodeURIComponent(code), { credentials:'same-origin' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(); })
      .then(function(b){
        $('bda-libelle').textContent = b.libelle; $('bda-montant').textContent = b.montant; $('bda-resume').hidden = false;
        if(b.paiementDisponible){ $('bda-ferme').hidden = true; form.hidden = false; }
        else afficherFerme();
      })
      .catch(function(){ afficherFerme(); });
  }

  function start(){
    form = $('bda-form'); errors = $('bda-errors'); status = $('bda-status');
    var nojs = $('bdq-nojs'); if(nojs) nojs.remove();
    if(location.hash) history.replaceState(null, '', location.pathname + location.search);   // ancien lien #t= : retiré
    cle = nouvelleCle();
    $('bda-q-offre').hidden = false;
    document.querySelectorAll('input[name=offre]').forEach(function(r){ r.addEventListener('change', function(){ choisir(r.value); }); });
    form.addEventListener('submit', envoyer);
    var o = new URLSearchParams(location.search).get('offre');
    if(o === '297' || o === '891') choisir(o);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
