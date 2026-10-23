/* Moteur des questionnaires « BD personnelle ».
   La page définit window.BDQ (texte remis à la personne, ordre des questions) ;
   ce script construit le formulaire, garde un brouillon sur l'appareil,
   vérifie les quelques champs nécessaires et envoie l'ensemble à Netlify Forms
   (formulaire déclaré en HTML statique, champs cachés). Aucun envoi ailleurs,
   aucun suivi, aucune ressource tierce. */
(function(){
  'use strict';
  var S = window.BDQ;
  if(!S) return;

  var root, form, draftBar, progressText, progressBar, errorsBox, statusEl;
  var saveTimer = null;
  var sent = false;
  var storageOk = (function(){ try{ var k='__bdq'; localStorage.setItem(k,'1'); localStorage.removeItem(k); return true; }catch(e){ return false; } })();

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

  /* ---------- brouillon sur l'appareil ---------- */
  function repeatCounts(){
    var c = {};
    root.querySelectorAll('[data-repeat]').forEach(function(r){ c[r.getAttribute('data-repeat')] = parseInt(r.getAttribute('data-count'), 10); });
    return c;
  }
  function scheduleSave(){
    if(!storageOk || !S.draftKey || sent) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 400);
  }
  function saveDraft(){
    if(sent) return;
    try{
      localStorage.setItem(S.draftKey, JSON.stringify({v:1, at: new Date().toISOString(), counts: repeatCounts(), values: collect()}));
      showDraftBar('Brouillon gardé sur cet appareil à ' + new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}) + '. Il reste dans ce navigateur jusqu’à l’envoi ; il n’est transmis à personne.');
    }catch(e){
      // Mémoire pleine ou refusée : on le dit, sans laisser croire à une sauvegarde.
      showDraftBar('Attention : le brouillon ne peut pas être gardé sur cet appareil. Vos dernières réponses seront perdues si la page se ferme ; pensez à envoyer en une fois.', true);
    }
  }
  function loadDraft(){
    if(!storageOk || !S.draftKey) return false;
    try{
      var d = JSON.parse(localStorage.getItem(S.draftKey) || 'null');
      if(!d || !d.values) return false;
      allRepeats().forEach(function(q){
        var cont = root.querySelector('[data-repeat="' + q.id + '"]');
        var n = d.counts && d.counts[q.id];
        if(cont && n && n > (q.initial || 1)) renderRepeat(q, cont, Math.min(n, q.max || n));
      });
      applyValues(d.values);
      var when = new Date(d.at);
      showDraftBar('Brouillon repris : vos réponses du ' + when.toLocaleDateString('fr-FR') + ' à ' + when.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'}) + ' sont revenues. Elles restent sur cet appareil jusqu’à l’envoi.');
      return true;
    }catch(e){ return false; }
  }
  function clearDraft(){
    // Annule une sauvegarde en attente : sinon elle recréerait le brouillon juste après l'effacement.
    clearTimeout(saveTimer); saveTimer = null;
    try{ if(S.draftKey) localStorage.removeItem(S.draftKey); }catch(e){}
  }
  function showDraftBar(text, warn){
    if(!draftBar) return;
    draftBar.querySelector('span').textContent = text;
    draftBar.classList.add('visible');
    draftBar.classList.toggle('warn', !!warn);
  }
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
      if(q.id === S.emailField) ok = vals[q.id] && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vals[q.id]);
      else ok = answered(q, vals);
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

  /* ---------- mise en texte des réponses ---------- */
  function asText(v){ return Array.isArray(v) ? v.join(' ; ') : v; }
  function renderAnswers(vals){
    var lines = [];
    S.sections.forEach(function(s){
      lines.push('', '== ' + s.title + ' ==');
      s.items.forEach(function(q){
        var head = (q.num ? q.num + '. ' : '') + q.label;
        if(q.type === 'accords'){
          q.items.forEach(function(a){
            lines.push('- ' + a.label + ' : ' + (vals[a.id] ? 'OUI' : 'non coché'));
            if(a.withText && vals[a.id + '.texte']) lines.push('  ' + vals[a.id + '.texte']);
          });
          return;
        }
        var parts = [];
        if(vals[q.id + '.__later']) parts.push('[Je préfère en parler pendant l’entretien.]');
        if(q.type === 'text' || q.type === 'textarea'){
          if(vals[q.id]) parts.push(vals[q.id]);
          if(vals[q.id + '.alt']) parts.push('[' + q.alt + ']');
        } else if(q.type === 'radio' || q.type === 'multi'){
          if(vals[q.id]) parts.push(asText(vals[q.id]) + (vals[q.id + '.autre'] ? ' — ' + vals[q.id + '.autre'] : ''));
        } else if(q.type === 'fields'){
          q.fields.forEach(function(f){
            var k = q.id + '.' + f.id;
            if(vals[k]) parts.push((f.label || f.id) + ' : ' + asText(vals[k]) + (vals[k + '.autre'] ? ' — ' + vals[k + '.autre'] : ''));
          });
        } else if(q.type === 'repeat'){
          var cont = root.querySelector('[data-repeat="' + q.id + '"]');
          var n = parseInt(cont.getAttribute('data-count'), 10);
          for(var i = 0; i < n; i++){
            var sub = [];
            q.fields.forEach(function(f){
              var k = q.id + '.' + i + '.' + f.id;
              if(vals[k]) sub.push('   ' + (f.label || f.id) + ' : ' + asText(vals[k]) + (vals[k + '.autre'] ? ' — ' + vals[k + '.autre'] : ''));
            });
            if(sub.length) parts.push(q.unit + ' ' + (i + 1) + '\n' + sub.join('\n'));
          }
        } else if(q.type === 'themes'){
          if(vals[q.id]) parts.push('Thèmes choisis : ' + asText(vals[q.id]));
          q.themes.forEach(function(t, i){
            if(!(vals[q.id] || []).includes(t.label)) return;
            t.questions.forEach(function(sq, j){
              var k = q.id + '.' + i + '.' + j;
              if(vals[k]) parts.push('   ' + t.label + ' — ' + sq + ' : ' + vals[k]);
            });
          });
        }
        lines.push('', head);
        lines.push(parts.length ? parts.join('\n') : '(sans réponse)');
      });
    });
    return lines.join('\n').trim();
  }

  /* Réponses envoyées : on retire les sous-réponses des thèmes décochés.
     Elles restent dans le brouillon local, pour le cas où la personne recoche. */
  function payloadValues(vals){
    var out = {};
    var drop = [];
    allQuestions().forEach(function(q){
      if(q.type !== 'themes') return;
      var chosen = vals[q.id] || [];
      q.themes.forEach(function(t, i){ if(chosen.indexOf(t.label) === -1) drop.push(q.id + '.' + i + '.'); });
    });
    Object.keys(vals).forEach(function(k){
      if(drop.some(function(pfx){ return k.indexOf(pfx) === 0; })) return;
      out[k] = vals[k];
    });
    return out;
  }

  /* ---------- envoi ---------- */
  function reference(){
    var d = new Date();
    var p = function(x){ return String(x).padStart(2, '0'); };
    var rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'BD-' + S.code + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + rnd;
  }
  function setHidden(name, value){
    var n = form.querySelector('input[type=hidden][name="' + name + '"]');
    if(n) n.value = value || '';
  }
  function downloadCopy(ref, text){
    var blob = new Blob([S.offre + '\nRéférence : ' + ref + '\n' + text + '\n'], {type:'text/plain;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = ref + '-mes-reponses.txt';
    document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function onSubmit(e){
    e.preventDefault();
    // Sauvegarde immédiate de la dernière saisie : un envoi refusé (champ manquant)
    // ou un échec réseau ne doit rien faire perdre. Un envoi réussi l'efface ensuite.
    clearTimeout(saveTimer);
    if(storageOk && !sent && S.draftKey) saveDraft();
    var vals = payloadValues(collect());
    var problems = validate(vals);
    if(problems.length){ showProblems(problems); return; }
    errorsBox.classList.remove('visible');

    var ref = reference();
    var text = renderAnswers(vals);
    setHidden('reference', ref);
    setHidden('offre', S.offre);
    setHidden('version', S.version);
    setHidden('prenom', vals[S.nameField] || '');
    setHidden('email', vals[S.emailField] || '');
    setHidden('whatsapp', vals[S.phoneField] || '');
    setHidden('accord_reponses', vals.accord_reponses ? 'oui' : 'non');
    setHidden('accord_documents', vals.accord_documents ? 'oui' : 'non');
    setHidden('accord_discuter', vals.accord_discuter ? ('oui — ' + (vals['accord_discuter.texte'] || '')) : 'non');
    setHidden('reponses', text);
    setHidden('reponses_json', JSON.stringify({counts: repeatCounts(), values: vals}));
    setHidden('envoye_le', new Date().toISOString());

    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    statusEl.className = 'bdq-status';
    statusEl.textContent = 'Envoi en cours…';
    // Seuls les champs déclarés en HTML (cachés + pot de miel) partent :
    // les réponses voyagent déjà, mises en texte, dans « reponses ».
    var params = new URLSearchParams();
    form.querySelectorAll('input[type=hidden][name], input[name="bot-field"]').forEach(function(n){ params.append(n.name, n.value); });
    var body = params.toString();
    fetch('/', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body})
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); })
      .then(function(){
        sent = true;
        clearDraft();
        document.querySelectorAll('[data-ref]').forEach(function(n){ n.textContent = ref; });
        var dl = document.querySelector('[data-download]');
        if(dl) dl.addEventListener('click', function(){ downloadCopy(ref, text); });
        document.body.classList.add('bdq-sent');
        window.scrollTo(0, 0);
        var done = document.querySelector('.bdq-done'); if(done) done.focus();
      })
      .catch(function(){
        btn.disabled = false;
        statusEl.className = 'bdq-status error';
        statusEl.textContent = 'L’envoi n’a pas fonctionné. Vos réponses restent sur cet appareil : réessayez dans un moment, ou écrivez à hello@younousjonas.com.';
      });
  }

  /* ---------- démarrage ---------- */
  function start(){
    root = document.getElementById('bdq-root');
    form = document.getElementById('bdq-form');
    draftBar = document.getElementById('bdq-draft');
    progressText = document.getElementById('bdq-progress-text');
    progressBar = document.getElementById('bdq-progress-bar');
    errorsBox = document.getElementById('bdq-errors');
    statusEl = document.getElementById('bdq-status');
    var nojs = document.getElementById('bdq-nojs'); if(nojs) nojs.remove();

    S.sections.forEach(function(s){
      var sec = el('section', {class:'bdq-section'});
      sec.appendChild(el('h2', {text: s.title}));
      if(s.intro) sec.appendChild(el('p', {text: s.intro}));
      s.items.forEach(function(q){ sec.appendChild(buildQuestion(q)); });
      if(s.after) sec.appendChild(el('p', {class:'bdq-notice', html: s.after}));
      root.appendChild(sec);
    });
    form.hidden = false;

    if(!storageOk && draftBar){ showDraftBar('Attention : le brouillon ne peut pas être gardé sur cet appareil (navigation privée ou stockage bloqué). Vos réponses seront perdues si la page se ferme ; pensez à envoyer en une fois.', true); draftBar.querySelector('button').hidden = true; }
    loadDraft();
    if(draftBar){
      draftBar.querySelector('button').addEventListener('click', function(){
        if(!confirm('Effacer toutes les réponses de ce questionnaire sur cet appareil ?')) return;
        clearDraft(); location.reload();
      });
    }
    root.addEventListener('input', function(){ refreshDynamic(); scheduleSave(); updateProgress(); });
    root.addEventListener('change', function(){ refreshDynamic(); scheduleSave(); updateProgress(); });
    form.addEventListener('submit', onSubmit);
    refreshDynamic(); updateProgress();
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
