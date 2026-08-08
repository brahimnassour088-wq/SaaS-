// ============================================================
// SERVEUR DU SAAS "MENU QR CODE"
// ============================================================
// Ce fichier est "le code derrière" (le backend).
// Il n'utilise QUE des outils déjà inclus dans Node.js
// (pas besoin d'installer quoi que ce soit avec npm install
// pour que ça tourne — donc pas besoin de carte bancaire).
//
// Ce que fait ce serveur :
// 1. Il garde en mémoire, dans le fichier db.json, un "tiroir"
//    par commerçant (ses produits, ses prix, son mot de passe).
// 2. Il affiche une page publique par commerçant → c'est CETTE
//    page que le QR code va pointer.
// 3. Il donne à chaque commerçant un espace privé (dashboard)
//    où il peut changer ses prix lui-même.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

const DB_PATH = path.join(__dirname, 'SAAS-db.json');
const PORT = process.env.PORT || 3000;

// Les "connexions actives" : qui a le droit d'entrer dans quel tiroir.
// (En mémoire : ça se vide si le serveur redémarre. Pour un vrai
// site avec beaucoup de monde, on ferait ça autrement plus tard.)
const sessions = {}; // token -> slug du commerçant
const tentatives = {}; // adresse IP -> { nombre, depuis }
const MAX_TENTATIVES = 5;
const BLOCAGE_MS = 10 * 60 * 1000; // 10 minutes

function adresseIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'inconnu').split(',')[0].trim();
}

function estBloque(ip) {
  const t = tentatives[ip];
  if (!t) return false;
  if (Date.now() - t.depuis > BLOCAGE_MS) {
    delete tentatives[ip];
    return false;
  }
  return t.nombre >= MAX_TENTATIVES;
}

function enregistrerEchec(ip) {
  const t = tentatives[ip] || { nombre: 0, depuis: Date.now() };
  t.nombre += 1;
  if (t.nombre === 1) t.depuis = Date.now();
  tentatives[ip] = t;
}

function reinitialiserTentatives(ip) {
  delete tentatives[ip];
}

// ------------------------------------------------------------
// OUTILS : lire / écrire le "classeur" (la base de données JSON)
// ------------------------------------------------------------
function lireDB() {
  const contenu = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(contenu);
}

function ecrireDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// ------------------------------------------------------------
// OUTILS : mot de passe (on ne stocke JAMAIS le mot de passe en clair)
// ------------------------------------------------------------
function hacherMotDePasse(motDePasse, sel) {
  return crypto.scryptSync(motDePasse, sel, 64).toString('hex');
}

function creerHachage(motDePasse) {
  const sel = crypto.randomBytes(16).toString('hex');
  const hash = hacherMotDePasse(motDePasse, sel);
  return { sel, hash };
}

function verifierMotDePasse(motDePasse, sel, hashAttendu) {
  const hash = hacherMotDePasse(motDePasse, sel);
  return hash === hashAttendu;
}

// ------------------------------------------------------------
// OUTILS : cookies (pour savoir "qui est connecté")
// ------------------------------------------------------------
function lireCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(paire => {
    const [cle, valeur] = paire.trim().split('=');
    if (cle) cookies[cle] = decodeURIComponent(valeur || '');
  });
  return cookies;
}

function slugDepuisRequete(req) {
  const cookies = lireCookies(req);
  const token = cookies.session;
  if (token && sessions[token]) return sessions[token];
  return null;
}

// ------------------------------------------------------------
// PAGES HTML (le "code devant", ici sous forme de gabarits simples)
// ------------------------------------------------------------
function pageAccueil() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Menu QR Code — Le menu digital de votre commerce</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="accueil">
    <header class="accueil-nav">
      <span class="accueil-marque">MENU<span class="point-ember">•</span>QR</span>
      <a href="/login" class="lien-discret">Se connecter</a>
    </header>

    <section class="accueil-hero">
      <div class="accueil-texte">
        <span class="eyebrow">Menu digital pour commerçants</span>
        <h1 class="accueil-titre">Votre carte,<br><em>un code à scanner.</em></h1>
        <p class="accueil-sous-titre">
          Fini les menus à réimprimer. Créez votre catalogue en ligne, obtenez votre QR code,
          et changez vos prix en direct — depuis votre téléphone.
        </p>
        <div class="accueil-cta">
          <a href="/signup" class="btn-primary">Créer mon menu — gratuit</a>
          <a href="/login" class="lien-discret accueil-cta-secondaire">J'ai déjà un compte</a>
        </div>
      </div>

      <div class="accueil-ticket" aria-hidden="true">
        <div class="ticket-tete">
          <span class="ticket-eyebrow">Aperçu</span>
          <span class="ticket-nom">Chez Vous</span>
        </div>
        <div class="ticket-rule"></div>
        <ul class="ticket-liste">
          <li><span>Plat du jour</span><i></i><b>1500 F</b></li>
          <li><span>Jus de bissap</span><i></i><b>500 F</b></li>
          <li><span>Brochette</span><i></i><b>1000 F</b></li>
        </ul>
        <div class="ticket-qr" aria-hidden="true">
          <div class="qr-faux">
            ${Array.from({length: 49}).map(() => `<span class="${Math.random() > 0.55 ? 'plein' : ''}"></span>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="accueil-features">
      <div class="feature-card">
        <span class="eyebrow">Sur la table</span>
        <h2>Un QR code, pas un catalogue papier</h2>
        <p>Le client scanne, voit votre carte à jour, sans app à installer.</p>
      </div>
      <div class="feature-card">
        <span class="eyebrow">Depuis votre téléphone</span>
        <h2>Vos prix changent en direct</h2>
        <p>Modifiez un plat, un prix, une rupture de stock — visible tout de suite.</p>
      </div>
      <div class="feature-card">
        <span class="eyebrow">Sans engagement</span>
        <h2>Créez votre compte en 2 minutes</h2>
        <p>Aucune carte bancaire, aucun rendez-vous. Juste un nom et un mot de passe.</p>
      </div>
    </section>

    <footer class="accueil-pied">
      <a href="/signup" class="btn-primary">Créer mon menu maintenant</a>
    </footer>
  </main>
</body>
</html>`;
}

function pageLogin(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion commerçant</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="auth-page">
    <div class="auth-card">
      <span class="eyebrow">Espace commerçant</span>
      <h1>Connexion</h1>
      ${erreur ? `<p class="form-error">${erreur}</p>` : ''}
      <form method="POST" action="/login" class="stack">
        <label>Identifiant
          <input name="slug" required autocomplete="username">
        </label>
        <label>Mot de passe
          <input type="password" name="motdepasse" required autocomplete="current-password">
        </label>
        <button type="submit" class="btn-primary">Se connecter</button>
      </form>
      <p class="lien-discret" style="margin-top:16px; text-align:center;">
        Pas encore de compte ? <a href="/signup" style="color:inherit; text-decoration:underline;">Créer un compte</a>
      </p>
    </div>
  </main>
</body>
</html>`;

}

function pageSignup(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Créer un compte commerçant</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="auth-page">
    <div class="auth-card">
      <span class="eyebrow">Espace commerçant</span>
      <h1>Créer un compte</h1>
      ${erreur ? `<p class="form-error">${erreur}</p>` : ''}
      <form method="POST" action="/signup" class="stack">
        <label>Nom du commerce
          <input name="nom" required placeholder="Ex: Chez Fatimé">
        </label>
        <label>Numéro Mobile Money (optionnel)
          <input name="telephonePaiement" placeholder="Ex: 65 00 84 85">
        </label>
        <label>Mot de passe
          <input type="password" name="motdepasse" required autocomplete="new-password" minlength="6">
        </label>
        <button type="submit" class="btn-primary">Créer mon compte</button>
      </form>
      <p class="lien-discret" style="margin-top:16px; text-align:center;">
        Déjà un compte ? <a href="/login" style="color:inherit; text-decoration:underline;">Se connecter</a>
      </p>
    </div>
  </main>
</body>
</html>`;
}

function pageDashboard(commercant, slug, hote) {
  const lienMenu = `https://${hote}/menu/${slug}`;
  const urlQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(lienMenu)}`;
  const lignesProduits = commercant.produits.map((p, i) => `
    <form method="POST" action="/dashboard/update" class="ligne-produit">
      <input type="hidden" name="index" value="${i}">
      <input name="nom" value="${p.nom}" required class="champ-nom">
      <div class="champ-prix">
        <input name="prix" type="number" value="${p.prix}" required>
        <span>F</span>
      </div>
      <div class="ligne-actions">
        <button type="submit" class="btn-mini btn-mini-save">Enregistrer</button>
        <button type="submit" formaction="/dashboard/delete" class="btn-mini btn-mini-delete">Supprimer</button>
      </div>
    </form>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tableau de bord — ${commercant.nom}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="dash-page">
    <header class="dash-head">
      <div>
        <span class="eyebrow">Tableau de bord</span>
        <h1>${commercant.nom}</h1>
      </div>
      <a href="/logout" class="lien-discret">Se déconnecter</a>
    </header>

    <a class="chip-lien" href="/menu/${slug}" target="_blank">
      <span>Page publique</span>
      <strong>/menu/${slug}</strong>
    </a>

    <section class="dash-section">
      <h2>Statistiques</h2>
      <p>Nombre de fois où des clients ont ouvert ton menu (en scannant le QR code ou via le lien).</p>
      <div class="bloc-qrcode" style="text-align:left;">
        <p style="font-size:2.2rem; font-weight:bold; margin:0;">${commercant.vues || 0}</p>
        <p style="margin:4px 0 0; opacity:0.8;">vue${(commercant.vues || 0) > 1 ? 's' : ''} au total</p>
      </div>
    </section>

    <section class="dash-section">
      <h2>Ton QR code</h2>
      <p>Les clients scannent ce code pour voir ton menu. Tu peux l'imprimer et le poser sur tes tables.</p>
      <div class="bloc-qrcode">
        <img src="${urlQrCode}" alt="QR code du menu de ${commercant.nom}" width="220" height="220">
        <a href="${urlQrCode}" download="qrcode-${slug}.png" class="btn-primary" style="margin-top:12px; display:inline-block;">Télécharger le QR code</a>
      </div>
    </section>

    <section class="dash-section">
      <h2>Tes produits</h2>
      <div class="liste-produits">
        ${lignesProduits}
      </div>
    </section>

    <section class="dash-section">
      <h2>Ajouter un produit</h2>
      <form method="POST" action="/dashboard/add" class="form-ajout">
        <input name="nom" placeholder="Nom du produit" required>
        <input name="prix" type="number" placeholder="Prix" required>
        <button type="submit" class="btn-primary">Ajouter</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function pageMenuPublic(commercant) {
  const lignesProduits = commercant.produits.map(p => `
    <li class="menu-item">
      <span class="item-nom">${p.nom}</span>
      <span class="item-leader" aria-hidden="true"></span>
      <span class="item-prix">${p.prix}<span class="item-devise"> F</span></span>
    </li>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${commercant.nom}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="menu-page">
    <div class="menu-card">
      <header class="menu-head">
        <span class="eyebrow">Menu</span>
        <h1>${commercant.nom}</h1>
      </header>
      <div class="grill-rule" aria-hidden="true"></div>
      <ul class="menu-list">
        ${lignesProduits}
      </ul>
      <footer class="menu-foot">Prix en Francs CFA</footer>
      ${commercant.telephonePaiement ? `<p class="menu-paiement">Paiement Mobile Money : <strong>${commercant.telephonePaiement}</strong></p>` : ''}
    </div>
  </main>
</body>
</html>`;
}

function pageErreur(message, code) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Erreur ${code}</title>
  <link rel="stylesheet" href="/style.css"></head>
  <body class="fond-braise"><main class="auth-page"><div class="auth-card">
    <span class="eyebrow">Erreur ${code}</span>
    <h1>${message}</h1>
  </div></main></body></html>`;
}

// ------------------------------------------------------------
// LE SERVEUR : qui répond à quelle adresse
// ------------------------------------------------------------
const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chemin = url.pathname;

  // --- Fichier CSS statique ---
  if (chemin === '/style.css') {
    const css = fs.readFileSync(path.join(__dirname, 'SAAS-style.css'));
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(css);
  }

  // --- Page publique du menu : CE LIEN VA DANS LE QR CODE ---
  if (chemin.startsWith('/menu/') && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce commerçant n\'existe pas.', 404));
    }
    // On compte cette visite (statistiques simples)
    commercant.vues = (commercant.vues || 0) + 1;
    ecrireDB(db);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageMenuPublic(commercant));
  }

  // --- Formulaire de connexion ---
  if (chemin === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageLogin(null));
  }

  // --- Page d'inscription ---
  if (chemin === '/signup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageSignup(null));
  }

  // --- Traitement de l'inscription ---
  if (chemin === '/signup' && req.method === 'POST') {
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { nom, motdepasse, telephonePaiement } = querystring.parse(corps);

      if (!nom || !motdepasse || motdepasse.length < 6) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageSignup('Nom du commerce et mot de passe (6 caractères min.) requis.'));
      }

      // On transforme le nom en identifiant simple pour l'adresse (slug)
      let slugBase = nom
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      if (!slugBase) slugBase = 'commerce';

      const db = lireDB();
      let slug = slugBase;
      let compteur = 2;
      while (db.commercants[slug]) {
        slug = `${slugBase}-${compteur}`;
        compteur++;
      }

      const { sel, hash } = creerHachage(motdepasse);
      db.commercants[slug] = {
        nom,
        sel,
        motDePasseHash: hash,
        telephonePaiement: telephonePaiement || '',
        produits: [{ nom: 'Exemple de produit', prix: 1000 }],
      };
      ecrireDB(db);

      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = slug;
      res.writeHead(302, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/`,
        Location: '/dashboard',
      });
      return res.end();
    });
    return;
  }

  // --- Traitement de la connexion ---
  if (chemin === '/login' && req.method === 'POST') {
    const ip = adresseIP(req);
    if (estBloque(ip)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageLogin('Trop de tentatives. Réessaie dans quelques minutes.'));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug, motdepasse } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];

      if (!commercant || !verifierMotDePasse(motdepasse, commercant.sel, commercant.motDePasseHash)) {
        enregistrerEchec(ip);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageLogin('Identifiant ou mot de passe incorrect.'));
      }

      reinitialiserTentatives(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = slug;
      res.writeHead(302, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/`,
        Location: '/dashboard',
      });
      return res.end();
    });
    return;
  }

  // --- Déconnexion ---
  if (chemin === '/logout') {
    const cookies = lireCookies(req);
    delete sessions[cookies.session];
    res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/login' });
    return res.end();
  }

  // --- Tableau de bord (protégé : il faut être connecté) ---
  if (chemin === '/dashboard' && req.method === 'GET') {
    const slug = slugDepuisRequete(req);
    if (!slug) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    const db = lireDB();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageDashboard(db.commercants[slug], slug, req.headers.host));
  }

  // --- Modifier un produit existant ---
  if (chemin === '/dashboard/update' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { index, nom, prix } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits[Number(index)] = { nom, prix: Number(prix) };
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Supprimer un produit ---
  if (chemin === '/dashboard/delete' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { index } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits.splice(Number(index), 1);
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Ajouter un produit ---
  if (chemin === '/dashboard/add' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { nom, prix } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits.push({ nom, prix: Number(prix) });
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Page d'accueil : présentation, avant de se connecter ---
  if (chemin === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageAccueil());
  }

  // --- Rien trouvé ---
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageErreur('Page introuvable.', 404));
});

serveur.listen(PORT, () => {
  console.log(`Serveur démarré : http://localhost:${PORT}`);
  console.log(`Page de connexion : http://localhost:${PORT}/login`);
});

module.exports = { creerHachage }; // utilisé par creer-compte.js
