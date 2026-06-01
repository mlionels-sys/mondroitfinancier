// netlify/functions/analyze.js
// Proxy sécurisé entre le front ContratScan et l'API Anthropic.
// La clé API reste exclusivement côté serveur (variable d'environnement ANTHROPIC_API_KEY).

const MODELE = 'claude-sonnet-4-20250514';      // modèle imposé côté serveur (le client ne le choisit pas)
const MAX_TOKENS_PLAFOND = 1500;                // plafond de tokens en sortie
const TAILLE_MAX_REQUETE = 5 * 1024 * 1024;     // 5 Mo de charge utile max (marge sous la limite Netlify ~6 Mo)

// Domaines autorisés à appeler la fonction.
// Configurable via la variable d'environnement ALLOWED_ORIGINS (valeurs séparées par des virgules).
const ORIGINES_AUTORISEES = (
  process.env.ALLOWED_ORIGINS || 'https://mondroitfinancier.netlify.app'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function entetesCors(origin) {
  const autorisee = origin && ORIGINES_AUTORISEES.includes(origin);
  return {
    'Access-Control-Allow-Origin': autorisee ? origin : ORIGINES_AUTORISEES[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const cors = entetesCors(origin);

  // Préflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // Contrôle d'origine : seul le site autorisé peut appeler la fonction.
  // (Un en-tête Origin peut être falsifié par un client non-navigateur ; ce contrôle bloque
  //  l'abus courant depuis un autre site, mais ne remplace pas une vraie limitation de débit.)
  if (!ORIGINES_AUTORISEES.includes(origin)) {
    return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Origine non autorisée' }) };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Configuration serveur manquante' }) };
  }

  // Contrôle de la taille de la requête
  const brut = event.body || '';
  if (Buffer.byteLength(brut, 'utf8') > TAILLE_MAX_REQUETE) {
    return {
      statusCode: 413,
      headers: cors,
      body: JSON.stringify({ error: 'Documents trop volumineux (3 Mo de fichiers maximum au total).' }),
    };
  }

  let corpsClient;
  try {
    corpsClient = JSON.parse(brut);
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Requête invalide' }) };
  }

  if (!Array.isArray(corpsClient.messages) || corpsClient.messages.length === 0) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Aucun message fourni' }) };
  }

  // On reconstruit la charge utile : le modèle est imposé, max_tokens est plafonné.
  // On ne transmet QUE system + messages venant du client.
  const charge = {
    model: MODELE,
    max_tokens: Math.min(Number(corpsClient.max_tokens) || 1000, MAX_TOKENS_PLAFOND),
    messages: corpsClient.messages,
  };
  if (typeof corpsClient.system === 'string' && corpsClient.system.length) {
    charge.system = corpsClient.system;
  }

  try {
    const reponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(charge),
    });

    const data = await reponse.json();

    // Propager les vraies erreurs de l'API au lieu de simuler un succès.
    if (!reponse.ok) {
      return {
        statusCode: reponse.status,
        headers: cors,
        body: JSON.stringify({ error: (data && data.error && data.error.message) || 'Erreur API' }),
      };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Service IA indisponible' }) };
  }
};
