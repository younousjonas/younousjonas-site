(function(){
  'use strict';
  var $ = function(id){ return document.getElementById(id); };
  var form = $('bdr-form');
  if(!form || !window.crypto || !window.crypto.getRandomValues || !window.fetch) return;
  var champs = $('bdr-champs'), recap = $('bdr-recap'), succes = $('bdr-succes');
  var confirmer = $('bdr-confirmer'), modifier = $('bdr-modifier');
  var declaration = null, cle = null, enCours = false, tentative = false, recu = null;

  function nouvelleCle(){
    var octets = new Uint8Array(32);
    window.crypto.getRandomValues(octets);
    var texte = '';
    for(var i = 0; i < octets.length; i++) texte += String.fromCharCode(octets[i]);
    return btoa(texte).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function erreur(id, message){
    var el = $(id);
    el.textContent = message || '';
    el.hidden = !message;
    if(message) el.focus();
  }
  function valeur(nom){ return form.elements[nom].value.trim(); }
  function occupe(valeur){
    enCours = valeur;
    confirmer.disabled = valeur;
    modifier.disabled = valeur;
    $('bdr-envoi-statut').textContent = valeur ? 'Transmission de votre déclaration…' : '';
    recap.setAttribute('aria-busy', String(valeur));
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    if(enCours) return;
    erreur('bdr-form-erreur', '');
    if(!form.reportValidity()) return;
    var d = {
      prenoms: valeur('prenoms'), nom: valeur('nom'), email: valeur('email').toLowerCase(),
      referenceCommande: valeur('referenceCommande'), elementsCommande: valeur('elementsCommande'),
      siteweb: valeur('siteweb')
    };
    if(!d.prenoms || !d.nom || !d.referenceCommande && !d.elementsCommande){
      erreur('bdr-form-erreur', 'Indiquez vos prénom(s), votre nom, et une référence de commande ou d’autres indications permettant d’identifier le contrat.');
      return;
    }
    // Le récapitulatif n'envoie aucune donnée. La clé reste identique en cas de reprise.
    if(!cle || tentative) cle = nouvelleCle();
    tentative = false;
    declaration = d;
    $('bdr-recap-prenoms').textContent = d.prenoms;
    $('bdr-recap-nom').textContent = d.nom;
    $('bdr-recap-email').textContent = d.email;
    $('bdr-recap-reference').textContent = d.referenceCommande || '(non renseignée)';
    $('bdr-recap-elements').textContent = d.elementsCommande || '(non renseignées)';
    erreur('bdr-envoi-erreur', '');
    form.hidden = true;
    recap.hidden = false;
    $('bdr-recap-titre').focus();
  });

  modifier.addEventListener('click', function(){
    if(enCours) return;
    recap.hidden = true;
    form.hidden = false;
    $('bdr-prenoms').focus();
  });

  confirmer.addEventListener('click', async function(){
    if(enCours || !declaration || recu) return;
    erreur('bdr-envoi-erreur', '');
    occupe(true);
    tentative = true;
    try{
      var response = await window.fetch('/.netlify/functions/bd-retractation', {
        method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'declarer', confirmation: true, cle: cle }, declaration))
      });
      var data = await response.json();
      if(!response.ok || !data || data.ok !== true || typeof data.accuse !== 'string' || !/^RET-[A-F0-9]{24}$/.test(data.reference)){
        var message = response.status === 422 ? 'Vérifiez les informations du formulaire. Votre déclaration n’a pas été enregistrée pour cet envoi.' : data && data.message;
        throw new Error(message || 'L’enregistrement n’a pas pu être confirmé. Réessayez avec ce bouton ou écrivez à younousjonas@gmail.com.');
      }
      recu = data;
      $('bdr-accuse').textContent = data.accuse;
      recap.hidden = true;
      succes.hidden = false;
      $('bdr-succes-titre').focus();
    }catch(e){
      erreur('bdr-envoi-erreur', e && e.message && !(e instanceof TypeError) ? e.message : 'La réponse n’a pas pu être reçue. Réessayez avec ce bouton : le même envoi ne sera pas enregistré deux fois. Vous pouvez aussi écrire à younousjonas@gmail.com.');
    }finally{ occupe(false); }
  });

  $('bdr-telecharger').addEventListener('click', function(){
    if(!recu) return;
    var url = URL.createObjectURL(new Blob([recu.accuse + '\n'], { type: 'text/plain;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = recu.reference + '-accuse-retractation.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  });

  // Rien n'est placé dans l'URL ni dans le stockage du navigateur.
  champs.disabled = false;
  $('bdr-nojs').hidden = true;
})();
