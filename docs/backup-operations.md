# Sauvegardes PostgreSQL — mise en place durable

## État vérifié le 5 novembre 2026

L’administration Railway du service Postgres indique `No backup schedule`. Elle permet de consulter et restaurer les anciens snapshots, mais demande l’offre Pro pour créer de nouvelles sauvegardes ou planifier leur exécution. Aucun abonnement n’a été modifié dans ce lot.

Une archive de production chiffrée du 4 novembre a été restaurée et contrôlée localement avant la publication de Buyer Engagement. Les copies temporaires ont ensuite été retirées. La sauvegarde et sa clé restent dans un dossier local privé hors du dépôt ; elles ne remplacent pas une copie extérieure à cet ordinateur.

## Mise en place proposée

1. Faire valider l’offre et son coût par le propriétaire avant tout changement d’abonnement. Le tarif officiel consulté est un minimum Pro de 20 USD de consommation par mois ; la consommation excédentaire et le stockage restent facturables. Aucun plafond total n’est déduit de ce minimum.
2. Dans le service **Postgres**, activer une fréquence quotidienne, puis vérifier la rétention effectivement proposée avant enregistrement. Ajouter une sauvegarde hebdomadaire si nécessaire pour conserver un recul suffisant. Ne pas restaurer une ancienne sauvegarde pour activer le planning.
3. Contrôler qu’un premier snapshot récent se termine avec succès. Un planning enregistré ou un volume existant ne prouve pas la présence d’une sauvegarde utilisable.
4. Répéter la restauration dans une cible isolée, sans clés de messagerie/CRM et sans trafic vers ces fournisseurs. Vérifier intégrité, comptes, commandes et droits ; conserver uniquement un compte rendu sans données nominatives. Retirer la copie après le contrôle.
5. Prévoir une archive logique chiffrée hors de Railway. Faire confirmer le stockage, le compte destinataire et les personnes pouvant y accéder **avant tout transfert** : l’archive contient notamment des données acheteurs, commandes et éléments d’authentification. Ne pas envoyer la clé de déchiffrement au même destinataire sans politique définie.
6. Prévoir un contrôle régulier de fraîcheur et un essai de restauration mensuel. Les alertes d’exploitation sont distinctes des relances commerciales et nécessitent leurs propres destinataires et moyens de notification.

## Limites

Le choix d’un autre stockage n’autorise ni son achat, ni la création de nouveaux accès permanents, ni le téléversement de données réelles vers un dossier partagé. Ne jamais déposer une archive, une clé ou une URL de connexion dans GitHub ou un artifact de CI.

La restauration de production reste une opération distincte : préciser l’instant à restaurer, les données qui pourraient être perdues depuis cet instant, la procédure de retour et l’autorisation du propriétaire. Aucun test ne doit écraser la base de production.

## Sources

- [Tarifs Railway](https://railway.com/pricing)
- [Documentation des sauvegardes](https://docs.railway.com/volumes/backups)
- Contrôle authentifié du service Postgres, onglet Backups, le 5 novembre 2026.
