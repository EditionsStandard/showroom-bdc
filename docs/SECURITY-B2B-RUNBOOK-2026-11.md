# Runbook de securite B2B — Novembre 2026

## Correctifs prepares
- robots.txt autorise l'exploration afin que les moteurs de recherche lisent les en-tetes X-Robots-Tag: noindex et les reponses 403. Bloquer le crawl empeche l'application de noindex sur les anciennes URLs.
- Les nouveaux slugs des liens de commande possedent 128 bits d'aleatoire (anciennement 32). Les liens deja transmis restent valides jusqu'a expiration ou revocation.
- Les routes de commande appliquent la duree de vie des sessions staff (30 minutes d'inactivite, 12 heures maximum).
- L'API du vieil index public des marques n'expose plus les liens lookbook.
- Des tests de non-regression couvrent les routes anon, la generation de liens et la duree de vie des sessions.

## Avant mise en ligne
1. Faire passer toute la CI GitHub (syntaxe, tests Node, parcours navigateur).
2. Verifier une sauvegarde PostgreSQL recente ET une restauration sur une base de test. Le volume Railway seul ne constitue pas une sauvegarde.
3. Confirmer avec des comptes de demonstration que buyer A ne peut voir ni les lignes ni les PDF de buyer B.
4. Verifier les droits agent par marque, l'ouverture de lien, l'expiration et la revocation.
5. Verifier NODE_ENV=production, SESSION_SECRET present et cookies Secure, HttpOnly, SameSite.
6. Tester login, commande, PDF, portail, admin et acces mobile.
7. Comparer le taux d'erreurs HTTP 5xx avant et apres la mise en ligne.

## Google Search Console
Inspecter l'ancienne URL de commande. Demander si necessaire sa suppression temporaire dans Removals, puis verifier que le prochain crawl voit noindex et non une interdiction robots.txt. Ne pas publier d'URL bearer dans des pages ou sitemaps publics.

## Chantiers distincts encore a traiter
- Site Cargo : audit du code du formulaire FW27, notamment les erreurs et confirmations de transmission.
- Railway Function fw27-cargo-intake : webhook Airtable en dur a migrer vers un secret d'environnement; controle de l'origine a restreindre a des domaines exacts; ajouter verification anti-spam et idempotence cote serveur. CORS seul n'authentifie pas une requete.
- Airtable : dedoublonner les demandes et relier aux fiches acheteurs; verifier les automatisations.
- Postgres : preuves de backup/restauration, politique de retention et plan de reprise.

## Rollback
En cas de regression, revenir au commit de la branche principale precedent le correctif, redeployer, puis verifier les routes d'auth et les commandes. Aucun changement destructif de base n'est necessaire pour ce lot.
