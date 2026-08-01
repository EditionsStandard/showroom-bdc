// Utilitaires CSV — parsing tolérant aux champs multi-lignes/guillemetés,
// protection anti-injection (OWASP CSV Injection), et parsing de prix
// tolérant au format tableur français. Fonctions pures, sans dépendance DB
// ni Express — extraites de server.js pour réduire ce fichier.

// Une valeur CSV qui commence par un caractère déclencheur peut exécuter du
// code une fois ouverte dans Excel/Sheets (cf. OWASP CSV Injection). On se
// limite à '=' et '@' (déclencheurs de formule sans ambiguïté) et aux
// caractères de contrôle tabulation/retour chariot : '+' et '-' ont été
// retirés du jeu de caractères piégés — un numéro de téléphone international
// ("+33 6 12 34 56 78", donnée courante pour cette app B2B France) partageait
// leur préfixe et se retrouvait corrompu par l'apostrophe ajoutée (invisible
// dans Excel mais visible et cassante pour tout autre consommateur du CSV —
// réimport, autre tableur, script).
function csvSafe(v) {
  const s = String(v == null ? '' : v);
  return /^[=@\t\r]/.test(s) ? "'" + s : s;
}

// Découpe un CSV en lignes en respectant les champs multi-lignes entre
// guillemets — un simple text.split('\n') coupe un tel champ en deux lignes
// indépendantes, corrompant silencieusement l'import (déjà vu : le mot
// suivant la coupure devient une "référence" à part entière). Bascule
// d'état à chaque guillemet rencontré (y compris les doublés "" d'échappement,
// qui se neutralisent en deux bascules — équivalent standard "nombre de
// guillemets impair = à l'intérieur d'un champ quoté").
function splitCSVLines(text) {
  const lines = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuote = !inQuote;
    if (ch === '\n' && !inQuote) { lines.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

function parseCSVRow(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  fields.push(cur);
  return fields;
}

// Accepte le séparateur décimal virgule (format tableur français : "12,50",
// "1.234,56") en plus du point — parseFloat('0,50') renverrait sinon 0 et
// ferait passer un article importé en gratuit sans aucune erreur remontée.
function parsePrice(v) {
  if (v === null || v === undefined) return 0;
  let s = String(v).trim();
  if (!s) return 0;
  // Retire tout ce qui n'est pas chiffre/virgule/point/signe moins (symbole
  // monétaire "€ "/"$"/espace insécable...) avant de parser — un prix formaté
  // "€ 32,00" (courant dans les exports linesheet de marque) fait échouer
  // parseFloat silencieusement (il s'arrête au premier caractère non
  // numérique), donnant 0 sans aucune erreur visible.
  s = s.replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  // Même plancher que nonNeg() (upsert produit unique) : un prix négatif
  // n'a pas de sens ici et n'était auparavant filtré que sur ce second chemin.
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = { csvSafe, splitCSVLines, parseCSVRow, parsePrice };
