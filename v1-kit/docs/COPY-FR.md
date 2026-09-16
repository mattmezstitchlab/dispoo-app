# Copie & vocabulaire — passe française

Double problème mesuré : **l'accentuation est absente du texte de l'app** (visible dans le
`textContent` brut du DOM, donc pas un artefact d'outil) **et le vocabulaire désigne la même
chose par 4 noms différents** (`events` / `Sondages` / `dates` / `options`).

## Vocabulaire unique (à appliquer partout, UI + API + variables affichées)

| Concept | Terme retenu | À supprimer |
|---|---|---|
| l'objet principal | **Événement** | sondage, événement à la carte |
| une proposition de date/heure | **Créneau** | date, option, slot |
| une personne invitée | **Invité** | participant, invité·e |
| les trois réponses | **Disponible / Peut-être / Indisponible** | yes / maybe / no dans l'UI |
| l'état final | **Confirmé** | validé, réservé, clos |
| l'action de l'organisateur | **Choisir ce créneau** | confirmer la date |
| le code à 6 caractères | **Code de l’événement** | code d'invitation, identifiant |

Les valeurs techniques en base (`status = 'sondage' | 'confirme'`, `value = yes|maybe|no`)
**ne changent pas** : seule la traduction en français propre se fait dans l'UI. Si vous
touchez aux valeurs en base, prévoyez un `UPDATE` de migration — ce n'est pas nécessaire ici.

## Chaînes à corriger (relevées à l'écran et dans le DOM)

| Aujourd'hui | Devient |
|---|---|
| `Nouvel evenement` | `Nouvel événement` |
| `evenements` (compteur) | `événements` — ou retirer le bloc (voir `FRONT-ROUTING.md` §6) |
| `invites` (compteur) | `invités` |
| `votes dispo` | `réponses disponibles` |
| `Tous` `Sondages` `Confirmes` `Passes` | `Tous` `En cours` `Confirmés` `Passés` |
| `Sondage en cours` (badge carte) | `En cours de vote` |
| `Confirme` (badge carte) | `Confirmé` |
| `dates` (carte) | `créneaux` |
| `Voter` | `Voter avec un code` |
| `Reessayer` | `Réessayer` |
| `Erreur 404` | `Impossible de charger vos événements` |
| `a Biarritz`, `pres de Bordeaux`, `Raclette d'hiver` (données de démo) | corriger les seeds, ou les retirer (`sql/001_v1_hardening.sql` §2) |
| `a venir`, `jour J` (labels de tâches) | `À venir` — et retirer les tâches de la V1 visible |
| `Trouvez la date parfaite.` | conserver (c'est la promesse, elle est bonne) |
| `Dispoo - proposez, partagez, votez. Tous les evenements` | `Dispoo — proposez, partagez, votez.` |
| `" introuvable"` (API) | `Événement introuvable` — corrigé par `api/_lib/guard.js` |
| `event_id requis` (API) | `Requête invalide` |

## Micro-règles

1. **Aucun texte en majuscules à moins de 13 px** : les `text-[10px] uppercase tracking-[0.2em]`
   relevés dans le CSS sont sous le seuil de lisibilité et le `text-neutral-400` sur blanc
   est à ~2,6:1 (AA exigé : 4,5:1). Passer ces micro-labels en `neutral-600` minimum, 11-12 px.
2. **Une seule casse typographique pour les accents** : ne jamais écrire `Evenement` en titre
   (l'accent en capitale est supporté : `É`).
3. **Une action = un verbe à l'infinitif** : `Copier le lien`, `Partager le sondage`,
   `Enregistrer mes disponibilités`, `Modifier mes disponibilités`, `Ajouter un créneau`.
4. **Les nombres en français** : `95 %` avec espace insécable (déjà le cas), `1 invité` /
   `2 invités` (gérer le pluriel — un `s` ajouté à l'aveugle fait `1 invités`).
