/* Demande d'intérêt « BD personnelle » : vérification légère dans le navigateur,
   vérification réelle côté serveur (fonction bd-interet). Aucun suivi, aucun tiers. */
(function(){
  'use strict';
  var form, errors, status;
  var LIBELLES = {
    offre: 'L’album qui vous intéresse', prenoms: 'Votre ou vos prénoms', nom: 'Votre nom',
    email: 'Une adresse électronique valide', whatsapp: 'Un numéro WhatsApp avec l’indicatif du pays (par exemple +262…)',
    declarationWhatsapp: 'La confirmation que ce numéro est joignable sur WhatsApp', consentement: 'Votre accord pour traiter la demande'
  };
  var ZONES = { offre:'bdi-q-offre', prenoms:'bdi-q-prenoms', nom:'bdi-q-nom', email:'bdi-q-email', whatsapp:'bdi-q-whatsapp', declarationWhatsapp:'bdi-q-whatsapp', consentement:'bdi-q-consentement' };

  function valeurs(){
    var o = form.querySelector('input[name=offre]:checked');
    return {
      offre: o ? o.value : '',
      prenoms: form.prenoms.value.trim(), nom: form.nom.value.trim(), email: form.email.value.trim(),
      whatsapp: form.whatsapp.value.trim(), declarationWhatsapp: form.declarationWhatsapp.checked,
      projet: form.projet.value.trim(), consentement: form.consentement.checked, siteweb: form.siteweb.value
    };
  }
  function whatsappOk(t){ var s = t.replace(/[\s.\-()]/g, ''); if(s.indexOf('00') === 0) s = '+' + s.slice(2); return /^\+[1-9]\d{7,14}$/.test(s); }
  function verifier(v){
    var m = [];
    if(!v.offre) m.push('offre'); if(!v.prenoms) m.push('prenoms'); if(!v.nom) m.push('nom');
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
      var z = document.getElementById(ZONES[c]); if(z) z.classList.add('error');
      var li = document.createElement('li'); li.textContent = LIBELLES[c] || c; ul.appendChild(li);
    });
    errors.appendChild(ul); errors.classList.add('visible'); errors.focus();
  }
  function envoyer(e){
    e.preventDefault();
    var v = valeurs(); var m = verifier(v);
    if(m.length){ montrer(m); return; }
    errors.classList.remove('visible');
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    status.className = 'bdq-status'; status.textContent = 'Envoi en cours…';
    fetch('/.netlify/functions/bd-interet', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(v), credentials:'same-origin' })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(b){ return { r:r, b:b }; }); })
      .then(function(x){
        if(x.r.status === 201){
          document.getElementById('bdi-ref').textContent = x.b.reference || '';
          form.hidden = true; var d = document.getElementById('bdi-done'); d.style.display = 'block'; d.focus(); window.scrollTo(0, 0);
          return;
        }
        btn.disabled = false;
        if(x.r.status === 422 && x.b.champs){ status.textContent = ''; montrer(x.b.champs); return; }
        status.className = 'bdq-status error';
        status.textContent = x.r.status === 429 ? 'Trop de demandes depuis cette connexion. Réessayez dans une heure, ou écrivez à hello@younousjonas.com.' : 'L’envoi n’a pas fonctionné. Réessayez dans un moment, ou écrivez à hello@younousjonas.com.';
      })
      .catch(function(){ btn.disabled = false; status.className = 'bdq-status error'; status.textContent = 'L’envoi n’a pas fonctionné. Réessayez dans un moment, ou écrivez à hello@younousjonas.com.'; });
  }
  function start(){
    form = document.getElementById('bdi-form'); errors = document.getElementById('bdi-errors'); status = document.getElementById('bdi-status');
    var nojs = document.getElementById('bdq-nojs'); if(nojs) nojs.remove();
    form.hidden = false;
    var o = new URLSearchParams(location.search).get('offre');
    if(o === '297' || o === '891'){ var r = form.querySelector('input[name=offre][value="' + o + '"]'); if(r) r.checked = true; }
    form.addEventListener('submit', envoyer);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
