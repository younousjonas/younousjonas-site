// Garde Edge : refuse toute soumission vers les deux anciens formulaires Netlify
// des questionnaires biographiques (retirés du site public le 23-10-2026),
// sur toutes les routes, en urlencoded comme en multipart. Les autres formulaires
// et les autres requêtes passent sans changement (context.next()).
// Les soumissions déjà reçues restent dans Netlify : rien n'est supprimé.

const FORMULAIRES_FERMES = ['biographies-parcours-297', 'biographies-histoire-891'];

// Lit le nom de formulaire d'une requête POST, sans consommer le corps de la requête d'origine.
async function nomFormulaire(req){
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if(!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) return null;
  let brut;
  try{ brut = await req.clone().text(); }catch{ return null; }
  if(ct.includes('application/x-www-form-urlencoded')){
    try{ return new URLSearchParams(brut).get('form-name'); }catch{ return null; }
  }
  // multipart : on cherche la partie « form-name » sans dépendre d'un analyseur complet.
  const m = brut.match(/name="form-name"\r?\n(?:[^\r\n]*\r?\n)*?\r?\n([^\r\n]*)/);
  return m ? m[1].trim() : null;
}

async function estFerme(req){
  if(req.method !== 'POST') return false;
  const nom = await nomFormulaire(req);
  return !!nom && FORMULAIRES_FERMES.includes(nom);
}

export default async (req, context) => {
  if(await estFerme(req)){
    return new Response('Ce questionnaire n’est plus ouvert ici. Merci de passer par https://younousjonas.com/bd-personnelle.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-bd-garde': 'formulaire-ferme' },
    });
  }
  return context.next();
};

export const config = { path: '/*', excludedPath: ['/.netlify/*'], method: 'POST' };
