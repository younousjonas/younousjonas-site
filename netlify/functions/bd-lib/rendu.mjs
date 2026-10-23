// Vérification et mise en texte des réponses, côté serveur (le navigateur n'est pas une autorité).

function toutes(schema){ const out = []; for(const s of schema.sections) for(const q of s.items) out.push(q); return out; }

// Ne garde que les clés connues du questionnaire et retire les réponses des thèmes non choisis.
export function filtrerValeurs(schema, valeurs, comptes){
  const v = valeurs && typeof valeurs === 'object' ? valeurs : {};
  const c = comptes && typeof comptes === 'object' ? comptes : {};
  const sortie = {}; const comptesSortie = {};
  const garder = (k, val) => {
    if(Array.isArray(val)) { const a = val.filter((x) => typeof x === 'string').map((x) => x.slice(0, 500)); if(a.length) sortie[k] = a; }
    else if(typeof val === 'string' && val.trim() !== '') sortie[k] = val.slice(0, 20000);
  };
  for(const q of toutes(schema)){
    const id = q.id;
    if(q.type === 'accords'){
      for(const a of q.items){ if(v[a.id] === 'oui') sortie[a.id] = 'oui'; if(a.withText) garder(a.id + '.texte', v[a.id + '.texte']); }
      continue;
    }
    garder(id + '.__later', v[id + '.__later']);
    if(q.type === 'text' || q.type === 'textarea'){ garder(id, v[id]); if(q.alt) garder(id + '.alt', v[id + '.alt']); }
    else if(q.type === 'radio' || q.type === 'multi'){ garder(id, v[id]); if(q.other) garder(id + '.autre', v[id + '.autre']); }
    else if(q.type === 'fields'){ for(const f of q.fields){ garder(id + '.' + f.id, v[id + '.' + f.id]); if(f.other) garder(id + '.' + f.id + '.autre', v[id + '.' + f.id + '.autre']); } }
    else if(q.type === 'repeat'){
      const n = Math.max(q.initial || 1, Math.min(Number(c[id]) || 0, q.max || 50));
      comptesSortie[id] = n;
      for(let i = 0; i < n; i++) for(const f of q.fields){ const k = `${id}.${i}.${f.id}`; garder(k, v[k]); if(f.other) garder(k + '.autre', v[k + '.autre']); }
    } else if(q.type === 'themes'){
      const choisis = (Array.isArray(v[id]) ? v[id] : []).filter((l) => q.themes.some((t) => t.label === l));
      if(choisis.length) sortie[id] = choisis;
      q.themes.forEach((t, i) => { if(!choisis.includes(t.label)) return; t.questions.forEach((_, j) => garder(`${id}.${i}.${j}`, v[`${id}.${i}.${j}`])); });
    }
  }
  return { valeurs: sortie, comptes: comptesSortie };
}

function repondu(q, v){
  if(v[q.id + '.__later']) return true;
  return Object.keys(v).some((k) => k === q.id || k.startsWith(q.id + '.'));
}

export function verifier(schema, v){
  const manques = [];
  for(const q of toutes(schema)){
    if(q.type === 'accords'){ for(const a of q.items) if(a.req && v[a.id] !== 'oui') manques.push(a.short || a.label); continue; }
    if(q.req && !repondu(q, v)) manques.push((q.num ? q.num + '. ' : '') + (q.short || q.label));
  }
  return manques;
}

const txt = (x) => Array.isArray(x) ? x.join(' ; ') : x;

export function mettreEnTexte(schema, v, comptes){
  const lignes = [];
  for(const s of schema.sections){
    lignes.push('', '== ' + s.title + ' ==');
    for(const q of s.items){
      const tete = (q.num ? q.num + '. ' : '') + q.label;
      if(q.type === 'accords'){
        for(const a of q.items){ lignes.push('- ' + a.label + ' : ' + (v[a.id] === 'oui' ? 'OUI' : 'non coché')); if(a.withText && v[a.id + '.texte']) lignes.push('  ' + v[a.id + '.texte']); }
        continue;
      }
      const p = [];
      if(v[q.id + '.__later']) p.push('[Je préfère en parler pendant l’entretien.]');
      if(q.type === 'text' || q.type === 'textarea'){ if(v[q.id]) p.push(v[q.id]); if(v[q.id + '.alt']) p.push('[' + q.alt + ']'); }
      else if(q.type === 'radio' || q.type === 'multi'){ if(v[q.id]) p.push(txt(v[q.id]) + (v[q.id + '.autre'] ? ' — ' + v[q.id + '.autre'] : '')); }
      else if(q.type === 'fields'){ for(const f of q.fields){ const k = q.id + '.' + f.id; if(v[k]) p.push((f.label || f.id) + ' : ' + txt(v[k]) + (v[k + '.autre'] ? ' — ' + v[k + '.autre'] : '')); } }
      else if(q.type === 'repeat'){
        const n = comptes[q.id] || q.initial || 1;
        for(let i = 0; i < n; i++){
          const sub = [];
          for(const f of q.fields){ const k = `${q.id}.${i}.${f.id}`; if(v[k]) sub.push('   ' + (f.label || f.id) + ' : ' + txt(v[k]) + (v[k + '.autre'] ? ' — ' + v[k + '.autre'] : '')); }
          if(sub.length) p.push(q.unit + ' ' + (i + 1) + '\n' + sub.join('\n'));
        }
      } else if(q.type === 'themes'){
        if(v[q.id]) p.push('Thèmes choisis : ' + txt(v[q.id]));
        q.themes.forEach((t, i) => { if(!(v[q.id] || []).includes(t.label)) return; t.questions.forEach((sq, j) => { const k = `${q.id}.${i}.${j}`; if(v[k]) p.push('   ' + t.label + ' — ' + sq + ' : ' + v[k]); }); });
      }
      lignes.push('', tete, p.length ? p.join('\n') : '(sans réponse)');
    }
  }
  return lignes.join('\n').trim();
}
