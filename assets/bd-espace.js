/* Espace privé « Mon album » : questionnaire complet, servi par la fonction
   bd-questionnaire après paiement constaté et ouverture d'une session privée
   (cookie HttpOnly). Le brouillon est enregistré côté serveur, dans l'espace
   de la commande : rien n'est gardé dans le navigateur. Aucun suivi, aucun tiers. */
(function(){
  'use strict';
  var API = '/.netlify/functions/bd-questionnaire';
  var S = null;                       // questionnaire reçu du serveur
  var root, form, draftBar, progressText, progressBar, errorsBox, statusEl;
  var saveTimer = null, sent = false, dernierEnvoi = '';
  /* ---------- petits outils DOM ---------- */
  function el(tag, attrs, kids){
    var n = document.createElement(tag);
    if(attrs) Object.keys(attrs).forEach(function(a){
      if(a === 'text') n.textContent = attrs[a];
      else if(a === 'html') n.innerHTML = attrs[a];
      else if(a === 'class') n.className = attrs[a];
      else n.setAttribute(a, attrs[a]);
    });
    (kids || []).forEach(function(k){ if(k) n.appendChild(k); });
    return n;
  }
  var uid = 0;
  function nextId(){ uid += 1; return 'bdq-f' + uid; }

  function titleNode(q){
    var t = el('p', {class:'bdq-title', id: 'bdq-t-' + q.id});
    if(q.num) t.appendChild(el('span', {class:'num', text: q.num + '.'}));
    t.appendChild(document.createTextNode(q.label));
    if(q.req) t.appendChild(el('span', {class:'bdq-req', text:'(nécessaire)'}));
    else if(q.opt) t.appendChild(el('span', {class:'bdq-opt', text:'(' + q.opt + ')'}));
    return t;
  }
  function hintNode(text){ return text ? el('p', {class:'bdq-hint', text: text}) : null; }

  /* ---------- champs élémentaires ---------- */
  function textInput(key, label, kind, extra){
    var id = nextId();
    var input = kind === 'textarea'
      ? el('textarea', {id:id, 'data-k':key, rows:'4'})
      : el('input', {id:id, type: kind || 'text', 'data-k':key});
    if(extra && extra.autocomplete) input.setAttribute('autocomplete', extra.autocomplete);
    if(extra && extra.placeholder) input.setAttribute('placeholder', extra.placeholder);
    if(!label) { input.setAttribute('aria-label', extra && extra.aria || key); return input; }
    return el('label', {class:'bdq-field', for:id}, [el('span', {text: label}), input]);
  }
  function choiceGroup(key, options, multi, other, label){
    var box = el('div', {class:'bdq-choices', role: multi ? 'group' : 'radiogroup'});
    if(label) box.appendChild(el('span', {class:'bdq-hint', text: label}));
    options.forEach(function(o){
      var inp = el('input', {type: multi ? 'checkbox' : 'radio', name: 'bdq_' + key, value:o, 'data-k':key, 'data-multi': multi ? '1' : '0'});
      box.appendChild(el('label', {class:'bdq-choice'}, [inp, el('span', {text:o})]));
    });
    if(other){
      var oinp = el('input', {type: multi ? 'checkbox' : 'radio', name:'bdq_' + key, value: other, 'data-k':key, 'data-multi': multi ? '1' : '0'});
      box.appendChild(el('label', {class:'bdq-choice'}, [oinp, el('span', {text: other})]));
      box.appendChild(textInput(key + '.autre', null, 'text', {aria: other + ' : préciser', placeholder: 'Préciser…'}));
    }
    return box;
  }
  function fieldNode(prefix, f){
    var key = prefix + '.' + f.id;
    if(f.kind === 'radio' || f.kind === 'multi') return choiceGroup(key, f.options, f.kind === 'multi', f.other, f.label);
    return textInput(key, f.label, f.kind || 'text');
  }

  /* ---------- blocs répétables ---------- */
  function renderRepeat(q, container, count){
    container.innerHTML = '';
    for(var i = 0; i < count; i++){
      var block = el('div', {class:'bdq-block', 'data-block': String(i)});
      var head = el('div', {class:'bdq-block-head'}, [el('strong', {text: q.unit + ' ' + (i + 1)})]);
      if(i >= (q.initial || 1)){
        var rm = el('button', {type:'button', class:'bdq-small-btn', text:'Retirer'});
        rm.addEventListener('click', (function(idx){ return function(){ removeBlock(q, container, idx); }; })(i));
        head.appendChild(rm);
      }
      block.appendChild(head);
      q.fields.forEach(function(f){ block.appendChild(fieldNode(q.id + '.' + i, f)); });
      container.appendChild(block);
    }
    container.setAttribute('data-count', String(count));
    var add = container.parentNode && container.parentNode.querySelector('[data-add="' + q.id + '"]');
    if(add) add.hidden = q.max && count >= q.max;
  }
  function blockValues(container){
    var vals = {};
    container.querySelectorAll('[data-k]').forEach(function(n){ readInto(vals, n); });
    return vals;
  }
  function removeBlock(q, container, idx){
    var vals = blockValues(container);
    var count = parseInt(container.getAttribute('data-count'), 10);
    var shifted = {};
    Object.keys(vals).forEach(function(k){
      var m = k.match(new RegExp('^' + q.id + '\\.(\\d+)\\.(.*)$'));
      if(!m) return;
      var n = parseInt(m[1], 10);
      if(n === idx) return;
      shifted[q.id + '.' + (n > idx ? n - 1 : n) + '.' + m[2]] = vals[k];
    });
    renderRepeat(q, container, count - 1);
    applyValues(shifted, container);
    scheduleSave(); updateProgress();
  }

  /* ---------- construction d'une question ---------- */
  function buildQuestion(q){
    var box = el('div', {class:'bdq-q', id:'bdq-q-' + q.id, 'data-q': q.id, role:'group', 'aria-labelledby':'bdq-t-' + q.id});
    box.appendChild(titleNode(q));
    var h = hintNode(q.hint); if(h) box.appendChild(h);

    if(q.type === 'text' || q.type === 'textarea'){
      box.appendChild(textInput(q.id, null, q.type === 'textarea' ? 'textarea' : (q.inputType || 'text'), {aria: q.label, autocomplete: q.autocomplete}));
      if(q.alt) box.appendChild(choiceGroup(q.id + '.alt', [q.alt], true));
    } else if(q.type === 'radio' || q.type === 'multi'){
      box.appendChild(choiceGroup(q.id, q.options, q.type === 'multi', q.other));
    } else if(q.type === 'fields'){
      q.fields.forEach(function(f){ box.appendChild(fieldNode(q.id, f)); });
    } else if(q.type === 'repeat'){
      var cont = el('div', {class:'bdq-repeat', 'data-repeat': q.id});
      box.appendChild(cont);
      var add = el('button', {type:'button', class:'bdq-small-btn', 'data-add': q.id, text: q.addLabel || ('Ajouter : ' + q.unit.toLowerCase())});
      box.appendChild(add);
      renderRepeat(q, cont, q.initial || 1);
      add.addEventListener('click', function(){
        var vals = blockValues(cont);
        var c = parseInt(cont.getAttribute('data-count'), 10);
        renderRepeat(q, cont, c + 1);
        applyValues(vals, cont);
        scheduleSave(); updateProgress();
        var last = cont.lastElementChild && cont.lastElementChild.querySelector('input,textarea');
        if(last) last.focus();
      });
      if(q.after) box.appendChild(hintNode(q.after));
    } else if(q.type === 'themes'){
      box.appendChild(choiceGroup(q.id, q.themes.map(function(t){ return t.label; }), true));
      q.themes.forEach(function(t, i){
        var th = el('div', {class:'bdq-theme', 'data-theme-of': q.id, 'data-theme': t.label});
        th.appendChild(el('strong', {text: t.label}));
        t.questions.forEach(function(sq, j){ th.appendChild(textInput(q.id + '.' + i + '.' + j, sq, 'textarea')); });
        box.appendChild(th);
      });
    } else if(q.type === 'accords'){
      box.classList.add('bdq-accords');
      q.items.forEach(function(a){
        var inp = el('input', {type:'checkbox', value:'oui', 'data-k': a.id, 'data-multi':'0'});
        box.appendChild(el('label', {class:'bdq-choice'}, [inp, el('span', {text: a.label + (a.req ? ' (nécessaire pour traiter votre demande)' : '')})]));
        if(a.withText) box.appendChild(textInput(a.id + '.texte', null, 'textarea', {aria: a.label}));
      });
    }

    if(S.later && q.later !== false && q.type !== 'accords'){
      var lid = nextId();
      var li = el('input', {type:'checkbox', id: lid, 'data-k': q.id + '.__later', 'data-multi':'0', value:'oui'});
      box.appendChild(el('label', {class:'bdq-later', for: lid}, [li, el('span', {text:'Je préfère en parler pendant l’entretien.'})]));
    }
    return box;
  }

  /* ---------- lecture et écriture des valeurs ---------- */
  function readInto(vals, n){
    var k = n.getAttribute('data-k');
    if(n.type === 'checkbox' || n.type === 'radio'){
      if(n.getAttribute('data-multi') === '1'){
        if(!vals[k]) vals[k] = [];
        if(n.checked) vals[k].push(n.value);
      } else if(n.checked){ vals[k] = n.value; }
    } else if(n.value.trim() !== ''){ vals[k] = n.value; }
  }
  function collect(){
    var vals = {};
    root.querySelectorAll('[data-k]').forEach(function(n){ readInto(vals, n); });
    Object.keys(vals).forEach(function(k){ if(Array.isArray(vals[k]) && !vals[k].length) delete vals[k]; });
    return vals;
  }
  function applyValues(vals, scope){
    (scope || root).querySelectorAll('[data-k]').forEach(function(n){
      var v = vals[n.getAttribute('data-k')];
      if(v === undefined) return;
      if(n.type === 'checkbox' || n.type === 'radio') n.checked = Array.isArray(v) ? v.indexOf(n.value) !== -1 : v === n.value;
      else n.value = v;
    });
    refreshDynamic();
  }
  function refreshDynamic(){
    root.querySelectorAll('[data-theme-of]').forEach(function(th){
      var key = th.getAttribute('data-theme-of');
      var on = !!root.querySelector('input[data-k="' + key + '"][value="' + cssEsc(th.getAttribute('data-theme')) + '"]:checked');
      th.classList.toggle('on', on);
    });
    root.querySelectorAll('.bdq-q').forEach(function(box){
      var l = box.querySelector('[data-k$=".__later"]');
      box.classList.toggle('later-on', !!(l && l.checked));
    });
  }
  function cssEsc(s){ return s.replace(/["\\]/g, '\\$&'); }
  function allQuestions(){
    var out = [];
    S.sections.forEach(function(s){ s.items.forEach(function(q){ out.push(q); }); });
    return out;
  }
  function allRepeats(){ return allQuestions().filter(function(q){ return q.type === 'repeat'; }); }

  /* ---------- progression et vérification ---------- */
  function answered(q, vals){
    if(vals[q.id + '.__later']) return true;
    var keys = Object.keys(vals);
    return keys.some(function(k){ return k === q.id || k.indexOf(q.id + '.') === 0; });
  }
  function updateProgress(){
    var qs = allQuestions().filter(function(q){ return q.type !== 'accords'; });
    var vals = collect();
    var done = qs.filter(function(q){ return answered(q, vals); }).length;
    if(progressText) progressText.textContent = done + ' question' + (done > 1 ? 's' : '') + ' sur ' + qs.length + ' avec une réponse. Les questions facultatives peuvent rester vides.';
    if(progressBar) progressBar.style.width = Math.round(100 * done / qs.length) + '%';
  }
  function validate(vals){
    var problems = [];
    root.querySelectorAll('.bdq-q.error').forEach(function(b){ b.classList.remove('error'); });
    allQuestions().forEach(function(q){
      if(q.type === 'accords'){
        q.items.forEach(function(a){ if(a.req && !vals[a.id]) problems.push({q:q, text: a.short || a.label}); });
        return;
      }
      if(!q.req) return;
      var ok;
      ok = answered(q, vals);
      if(!ok) problems.push({q:q, text: (q.num ? q.num + '. ' : '') + (q.short || q.label)});
    });
    return problems;
  }
  function showProblems(problems){
    errorsBox.innerHTML = '';
    errorsBox.appendChild(document.createTextNode('Il manque quelques réponses nécessaires :'));
    var ul = el('ul');
    problems.forEach(function(p){
      document.getElementById('bdq-q-' + p.q.id).classList.add('error');
      var a = el('a', {href:'#bdq-q-' + p.q.id, text: p.text});
      ul.appendChild(el('li', null, [a]));
    });
    errorsBox.appendChild(ul);
    errorsBox.classList.add('visible');
    errorsBox.focus();
  }

  /* ---------- brouillon côté serveur ---------- */
  function repeatCounts(){
    var c = {};
    root.querySelectorAll('[data-repeat]').forEach(function(r){ c[r.getAttribute('data-repeat')] = parseInt(r.getAttribute('data-count'), 10); });
    return c;
  }
  function showDraftBar(text, warn){
    draftBar.querySelector('span').textContent = text;
    draftBar.classList.add('visible');
    draftBar.classList.toggle('warn', !!warn);
  }
  function heure(iso){ return new Date(iso).toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}); }
  function scheduleSave(){ if(sent) return; clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 1500); }
  function saveDraft(){
    if(sent) return Promise.resolve();
    clearTimeout(saveTimer); saveTimer = null;
    var corps = JSON.stringify({ valeurs: collect(), comptes: repeatCounts() });
    if(corps === dernierEnvoi) return Promise.resolve();
    return fetch(API, { method:'PUT', headers:{'Content-Type':'application/json'}, body: corps, credentials:'same-origin' })
      .then(function(r){
        if(r.status === 401) { sessionPerdue(); return; }
        if(!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().then(function(b){ dernierEnvoi = corps; showDraftBar('Brouillon enregistré à ' + heure(b.majLe) + ' dans votre espace privé. Vous pouvez reprendre plus tard avec votre lien personnel.'); });
      })
      .catch(function(){ showDraftBar('Attention : le brouillon n’a pas pu être enregistré. Vos dernières réponses seront perdues si la page se ferme ; réessayez dans un moment.', true); });
  }
  function applyDraft(d){
    if(!d || !d.valeurs) return;
    allRepeats().forEach(function(q){
      var cont = root.querySelector('[data-repeat="' + q.id + '"]');
      var n = d.comptes && d.comptes[q.id];
      if(cont && n && n > (q.initial || 1)) renderRepeat(q, cont, Math.min(n, q.max || n));
    });
    applyValues(d.valeurs);
    dernierEnvoi = JSON.stringify({ valeurs: collect(), comptes: repeatCounts() });
    showDraftBar('Brouillon repris : vos réponses enregistrées à ' + heure(d.majLe) + ' sont revenues.');
  }
  function effacerBrouillon(){
    if(!confirm('Effacer toutes les réponses enregistrées de ce questionnaire ?')) return;
    clearTimeout(saveTimer);
    fetch(API, { method:'DELETE', credentials:'same-origin' }).then(function(){ location.reload(); });
  }

  /* ---------- envoi ---------- */
  function downloadCopy(ref, text){
    var blob = new Blob([S.offre + '\nRéférence : ' + ref + '\n\n' + text + '\n'], {type:'text/plain;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = ref + '-mes-reponses.txt';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function onSubmit(e){
    e.preventDefault();
    var vals = collect();
    var problems = validate(vals);
    if(problems.length){ saveDraft(); showProblems(problems); return; }
    errorsBox.classList.remove('visible');
    var btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    statusEl.className = 'bdq-status'; statusEl.textContent = 'Envoi en cours…';
    saveDraft().then(function(){
      return fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ action:'envoyer', valeurs: collect(), comptes: repeatCounts() }) });
    }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(b){ return { r:r, b:b }; }); })
      .then(function(x){
        if(x.r.ok){
          sent = true; clearTimeout(saveTimer);
          document.querySelectorAll('[data-ref]').forEach(function(n){ n.textContent = x.b.reference; });
          var dl = document.querySelector('[data-download]'); if(dl) dl.addEventListener('click', function(){ downloadCopy(x.b.reference, x.b.texte || ''); });
          document.body.classList.add('bdq-sent'); window.scrollTo(0, 0);
          return;
        }
        btn.disabled = false;
        if(x.r.status === 401){ sessionPerdue(); return; }
        if(x.r.status === 422 && x.b.manques){
          statusEl.textContent = '';
          errorsBox.innerHTML = ''; errorsBox.appendChild(document.createTextNode('Il manque quelques réponses nécessaires :'));
          var ul = document.createElement('ul'); x.b.manques.forEach(function(m){ var li = document.createElement('li'); li.textContent = m; ul.appendChild(li); });
          errorsBox.appendChild(ul); errorsBox.classList.add('visible'); errorsBox.focus(); return;
        }
        statusEl.className = 'bdq-status error';
        statusEl.textContent = x.r.status === 409 ? 'Ce questionnaire a déjà été envoyé.' : 'L’envoi n’a pas fonctionné. Vos réponses restent enregistrées : réessayez dans un moment.';
      })
      .catch(function(){ btn.disabled = false; statusEl.className = 'bdq-status error'; statusEl.textContent = 'L’envoi n’a pas fonctionné. Vos réponses restent enregistrées : réessayez dans un moment.'; });
  }

  /* ---------- session et démarrage ---------- */
  function etat(id){ ['bde-chargement','bde-perdu','bde-espace','bde-deja'].forEach(function(x){ var n = document.getElementById(x); if(n) n.hidden = (x !== id); }); }
  function sessionPerdue(){ clearTimeout(saveTimer); etat('bde-perdu'); }
  function construire(d){
    S = { sections: d.schema.sections, later: !!d.schema.later, offre: d.offre };
    document.getElementById('bde-offre').textContent = d.offre;
    document.getElementById('bde-prenom').textContent = d.prenom;
    document.getElementById('bde-ref').textContent = d.reference;
    var pd = document.getElementById('bde-prenom-deja'); if(pd) pd.textContent = d.prenom;
    if(d.envoye){ etat('bde-deja'); return; }
    var intro = document.getElementById('bde-intro-' + d.code); if(intro) intro.hidden = false;
    S.sections.forEach(function(s){
      var sec = el('section', {class:'bdq-section'});
      sec.appendChild(el('h2', {text: s.title}));
      if(s.intro) sec.appendChild(el('p', {text: s.intro}));
      s.items.forEach(function(q){ sec.appendChild(buildQuestion(q)); });
      if(s.after) sec.appendChild(el('p', {class:'bdq-notice', html: s.after}));
      root.appendChild(sec);
    });
    applyDraft(d.brouillon);
    root.addEventListener('input', function(){ refreshDynamic(); scheduleSave(); updateProgress(); });
    root.addEventListener('change', function(){ refreshDynamic(); scheduleSave(); updateProgress(); });
    form.addEventListener('submit', onSubmit);
    draftBar.querySelector('button').addEventListener('click', effacerBrouillon);
    refreshDynamic(); updateProgress();
    etat('bde-espace');
  }
  function charger(){
    return fetch(API, { credentials:'same-origin' }).then(function(r){
      if(r.status === 401){ etat('bde-perdu'); return; }
      return r.json().then(construire);
    }).catch(function(){ etat('bde-perdu'); });
  }
  function ouvrir(cle){
    return fetch('/.netlify/functions/bd-acces', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ action:'ouvrir', jeton: cle }) });
  }
  function recuperer(e){
    e.preventDefault();
    var f = e.target; var msg = document.getElementById('bde-recup-msg');
    fetch('/.netlify/functions/bd-acces', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ action:'recuperer', email: f.email.value.trim() }) })
      .then(function(r){ return r.json(); }).then(function(b){ msg.textContent = b.message || 'Demande reçue.'; })
      .catch(function(){ msg.textContent = 'La demande n’a pas pu partir. Réessayez dans un moment.'; });
  }
  function fermer(){
    fetch('/.netlify/functions/bd-acces', { method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body: JSON.stringify({ action:'fermer' }) })
      .then(function(){ location.replace('/mon-album'); });
  }
  function start(){
    root = document.getElementById('bdq-root'); form = document.getElementById('bdq-form');
    draftBar = document.getElementById('bdq-draft'); progressText = document.getElementById('bdq-progress-text');
    progressBar = document.getElementById('bdq-progress-bar'); errorsBox = document.getElementById('bdq-errors'); statusEl = document.getElementById('bdq-status');
    var nojs = document.getElementById('bdq-nojs'); if(nojs) nojs.remove();
    document.getElementById('bde-recup').addEventListener('submit', recuperer);
    document.querySelectorAll('[data-fermer]').forEach(function(b){ b.addEventListener('click', fermer); });
    // Le lien personnel est dans le fragment (#cle=…) : jamais envoyé au serveur dans l'URL,
    // jamais transmis en Referer. On le retire aussitôt de la barre d'adresse.
    // Un lien ouvert dans un onglet déjà sur cette page ne change que le fragment : on le traite aussi.
    window.addEventListener('hashchange', function(){ if(/^#cle=/.test(location.hash)) location.reload(); });
    etat('bde-chargement');
    var m = location.hash.match(/^#cle=([A-Za-z0-9_-]{43})$/);
    if(location.hash) history.replaceState(null, '', location.pathname);
    if(m){ ouvrir(m[1]).then(function(r){ if(r.ok) return charger(); etat('bde-perdu'); }).catch(function(){ etat('bde-perdu'); }); }
    else charger();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
