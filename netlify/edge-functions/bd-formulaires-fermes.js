// Garde Edge : refuse toute soumission vers les deux anciens formulaires Netlify
// des questionnaires biographiques (retirés du site public le 23-10-2026),
// sur toutes les routes, en urlencoded comme en multipart. Les autres formulaires
// et les autres requêtes passent sans changement (context.next()).
// Les soumissions déjà reçues restent dans Netlify : rien n'est supprimé.

const FORMULAIRES_FERMES = ['biographies-parcours-297', 'biographies-histoire-891'];
const ferme = (v) => typeof v === 'string' && FORMULAIRES_FERMES.includes(v.trim().toLowerCase());

// Toutes les valeurs « form-name » du corps (doublons compris), lues sur une copie de la requête.
// Si le corps ne s'analyse pas, on retombe sur une recherche des deux noms dans le texte brut :
// dans le doute, un corps illisible qui les contient est refusé.
async function verdict(req){
  if(req.method !== 'POST') return false;
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if(!ct.includes('application/x-www-form-urlencoded') && !ct.includes('multipart/form-data')) return false;
  try{
    const fd = await req.clone().formData();
    return fd.getAll('form-name').some(ferme);
  }catch{
    try{
      const brut = (await req.clone().text()).toLowerCase();
      return FORMULAIRES_FERMES.some((n) => brut.includes(n));
    }catch{ return false; }
  }
}

export default async (req, context) => {
  if(await verdict(req)){
    return new Response('Ce questionnaire n’est plus ouvert ici. Merci de passer par https://younousjonas.com/bd-personnelle.', {
      status: 410,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-bd-garde': 'formulaire-ferme' },
    });
  }
  return context.next();
};

export const config = { path: '/*', excludedPath: ['/.netlify/*'], method: 'POST' };
