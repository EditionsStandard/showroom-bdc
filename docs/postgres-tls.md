# Connexion PostgreSQL authentifiée

Ce lot remplace `rejectUnauthorized:false` par une vérification obligatoire du certificat pour toute destination distante. Il ne modifie ni données, ni comptes, ni règles d’engagement. Le déploiement nécessite la préparation des variables de confiance avant la fusion.

## Configuration

`lib/postgres-connection.js` est l’unique configuration de connexion importée par `database.js`.

- Les destinations distantes exigent TLS 1.2 au minimum, une chaîne de confiance valide et le nom attendu dans le certificat. Aucun repli non chiffré ou non vérifié n’existe.
- Les connexions locales `localhost`, `127.0.0.1` et `::1` restent compatibles avec PostgreSQL de développement sans TLS. Ajouter `sslmode=require` à une URL locale exige au contraire une connexion TLS vérifiée.
- Pour une autorité privée : fournir **une seule** variable, `PG_TLS_CA_PEM` (bundle PEM pur) ou `PG_TLS_CA_BASE64` (même bundle encodé en base64). Une clé privée, un certificat illisible, un encodage invalide ou deux sources simultanées sont refusés.
- `PG_TLS_SERVERNAME` définit une identité de certificat différente du nom de transport. Cette option exige une autorité explicitement fournie. Elle ne change pas l’adresse de connexion : celle-ci reste celle de `DATABASE_URL`.
- `sslmode=require`, `verify-ca` et `verify-full` deviennent tous une vérification complète. `disable` est interdit pour une destination distante. Les modes permissifs ne sont pas acceptés.
- Les options d’URL susceptibles d’écraser la politique TLS ou l’adresse effective sont rejetées. Le paramètre `sslmode` validé est retiré de l’URL avant transmission à node-postgres, qui autrement pourrait écraser l’objet `ssl`.
- L’identité est contrôlée explicitement même pour une adresse IP ; elle ne dépend pas d’une valeur SNI implicite du pilote. La prise en charge du channel binding est activée.

Les erreurs de configuration et l’outil de contrôle n’affichent jamais l’URL ou le mot de passe.

## Préparation Railway

Le certificat observé le 5 novembre 2026 sur le service PostgreSQL identifie `localhost`, avec une autorité privée `root-ca`. L’adresse privée du service reste l’adresse réseau de connexion. Le certificat présenté par le réseau est une **candidature**, pas une autorité de confiance par lui-même.

1. Lire le certificat **public** de l’autorité par un canal Railway authentifié, par exemple `/var/lib/postgresql/data/certs/root.crt` depuis la console/fichiers du service. Ne jamais lire ou télécharger `root.key` ou `server.key`.
2. Comparer son empreinte SHA-256 à l’autorité présentée par le serveur. Normaliser le certificat en PEM pur. N’utiliser aucune autorité reçue uniquement par une connexion initialement non vérifiée.
3. Préparer `PG_TLS_CA_BASE64` et `PG_TLS_SERVERNAME=localhost` sur **showroom-bdc**. L’ancien code ignore ces deux nouvelles variables ; leur préparation ne justifie pas une modification ou un redémarrage de PostgreSQL.
4. Tester la négociation TLS complète avec ce bundle et cette identité. `node scripts/check-postgres-tls.cjs` effectue ensuite un contrôle SQL en lecture seule, sans migrations ni données acheteurs.
5. Fusionner seulement après sauvegarde récente, validation des tests et confirmation de la confiance. Le contrôle de déploiement existant ouvre lui aussi une connexion à la base avec cette configuration : un certificat refusé doit bloquer la nouvelle version, sans remplacer celle qui tourne.
6. Vérifier connexion propriétaire, portail et journaux après publication. Aucune relance email ou écriture CRM n’est nécessaire à cette validation.

## Rotation et reprise

Le modèle Railway peut régénérer les certificats lors d’un redémarrage proche de leur expiration. Contrôler les dates et préparer la nouvelle autorité avant cette échéance. Une rotation planifiée peut utiliser un bundle contenant temporairement les deux autorités vérifiées, puis retirer l’ancienne après bascule et contrôle.

En cas de refus, corriger l’autorité, son encodage ou l’identité attendue. Ne pas restaurer `rejectUnauthorized:false`, modifier le nom attendu au hasard, désactiver TLS ou régénérer des clés de production pour faire passer le contrôle. Une restauration de base n’est pas le remède à une erreur de confiance TLS.

## Sources techniques

- [SSL node-postgres et remplacement des options par l’URL](https://node-postgres.com/features/ssl)
- [Vérification de certificat et d’identité Node.js](https://nodejs.org/api/tls.html#tlsconnectoptions-callback)
- [Génération des certificats du modèle Railway](https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh)

## Validation du lot

Treize tests spécifiques couvrent la configuration et de vraies négociations TLS via node-postgres sur un transport PostgreSQL synthétique local : autorité correcte ou incorrecte, nom attendu correct ou incorrect, connexion par IP, refus TLS sans repli et tentatives de contournement par l’URL. La suite complète locale passe 385 tests.

Une répétition supplémentaire a exécuté `check-postgres-tls.cjs` sur un véritable PostgreSQL local isolé, avec une autorité et des certificats fictifs : connexion authentifiée en TLS 1.3, requête en lecture seule, rejet d’un nom incorrect et d’une autorité inconnue. Cette instance et ses certificats ont été retirés après le contrôle.

Ces résultats ne constituent pas encore une preuve de connexion authentifiée à la production : la vérification indépendante de l’autorité, le contrôle réel et la CI du commit publié doivent être enregistrés séparément.
