-- Dispoo V1 — durcissement du schéma existant.
-- AJOUTATIF UNIQUEMENT : aucune table supprimée, aucune colonne retirée, aucune donnée effacée.
-- Les noms de tables/colonnes sont ceux OBSERVÉS dans les payloads de l'API du 15/09/2026
-- (events, options, participants, votes, tasks). TODO(verify): ajuster aux noms réels
-- avant exécution, puis relire chaque `ALTER TABLE`.
--
-- Execute : psql "$POSTGRES_URL" -f 001_v1_hardening.sql

BEGIN;

-- ============================================================ 1. created_at / updated_at
-- Constat : created_at valait NULL sur 100 % des lignes de toutes les tables.
-- Conséquences mesurées : ordre de la liste instable (2,3,4,1,5) et onglet « Passés »
-- structurellement vide.

ALTER TABLE events       ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE options      ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE participants ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE votes        ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE tasks        ALTER COLUMN created_at SET DEFAULT now();

ALTER TABLE events       ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE options      ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Backfill déterministe (les seeds n'ont pas de date : on les fige une fois pour toutes,
-- id croissant = plus récent, pour ne pas faire « sauter » les cartes à chaque reload).
UPDATE events       SET created_at = coalesce(created_at,      '2026-01-01T00:00:00Z'::timestamptz + (id * interval '1 hour')) WHERE created_at IS NULL;
UPDATE options      SET created_at = coalesce(created_at,      '2026-01-01T00:00:00Z'::timestamptz + (id * interval '1 hour')) WHERE created_at IS NULL;
UPDATE participants SET created_at = coalesce(created_at,      '2026-01-01T00:00:00Z'::timestamptz + (id * interval '1 hour')) WHERE created_at IS NULL;
UPDATE votes        SET created_at = coalesce(created_at,      '2026-01-01T00:00:00Z'::timestamptz + (id * interval '1 minute')) WHERE created_at IS NULL;
UPDATE tasks        SET created_at = coalesce(created_at,      '2026-01-01T00:00:00Z'::timestamptz + (id * interval '1 hour')) WHERE created_at IS NULL;
UPDATE events       SET updated_at = created_at WHERE updated_at IS NULL;

-- updated_at maintenu par trigger (aucun changement de code applicatif nécessaire).
CREATE OR REPLACE FUNCTION dispoo_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['events','options','participants','votes','tasks'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = t || '_touch_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION dispoo_touch_updated_at()',
        t || '_touch_updated_at', t
      );
    END IF;
  END LOOP;
END $$;

-- Le tri de la liste ne doit plus jamais dépendre de l'ordre implicite de Postgres.
CREATE INDEX IF NOT EXISTS events_created_at_desc ON events (created_at DESC NULLS LAST);

-- ============================================================ 2. séparation démo / réel
-- Constat : ids 1,2,3 = seeds (« Week-end surf à Biarritz », « Mariage de Lea & Hugo »,
-- « Raclette d'hiver »), ids 4,5 = créations réelles via l'UI (« Mariage », « QA Test Event »).
-- Un utilisateur réel voyait donc 3 évènements qui ne sont pas les siens, et un compteur
-- « 5 évènements / 16 invités / 27 votes » faux.

ALTER TABLE events ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

UPDATE events SET is_demo = true WHERE id IN (1,2,3);
-- ^ TODO(verify): confirmer la liste des seeds avec `SELECT id,title,is_demo FROM events ORDER BY id;`
-- Option radicale (recommandée si ces 3 lignes ne servent plus à rien en prod) :
--   DELETE FROM votes        WHERE option_id IN (SELECT id FROM options        WHERE event_id IN (1,2,3));
--   DELETE FROM participants WHERE event_id IN (1,2,3);
--   DELETE FROM tasks        WHERE event_id IN (1,2,3);
--   DELETE FROM options      WHERE event_id IN (1,2,3);
--   DELETE FROM events       WHERE id IN (1,2,3);
-- Ne l'exécuter qu'après sauvegarde, et uniquement si rien ne casse côté UI.

-- « QA Test Event » (id 5) et tout résidu de QA :
--   DELETE FROM events WHERE title ILIKE '%qa test%' OR title ILIKE '%test%' AND is_demo = false;

-- ============================================================ 3. propriété minimale
-- Constat : aucun endpoint protégé, pas de cookie, pas de token, `email` toujours NULL.

ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_token_hash text;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at      timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS events_code_key ON events (code);
CREATE INDEX IF NOT EXISTS events_owner_token_hash_idx ON events (owner_token_hash);

-- Les évènements existants n'ont pas de propriétaire : ils restent en lecture par code,
-- non modifiables tant que l'UI n'a pas récupéré le token. TODO(verify): si l'app doit
-- permettre de reprendre la main sur un évènement créé avant ce patch, prévoir une
-- réédition manuelle du token côté admin, sinon laisser NULL (refus d'écriture = 403).

-- ============================================================ 4. unicité invités + votes
-- Constat : « Chloé » et « chloe » = 2 invités distincts possibles ; l'invité 13 de
-- l'évènement 2 n'a voté que sur 2 créneaux sur 3, et `turnout` le compte quand même.

ALTER TABLE participants ADD COLUMN IF NOT EXISTS normalized_name text;
UPDATE participants
   SET normalized_name = regexp_replace(
         lower(translate(name, 'àáâãäåçèéêëìíîïðñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinoooooouuuuyy')),
         '[^a-z0-9]', '', 'g')
 WHERE normalized_name IS NULL;

-- Doublons déjà présents (« Chloé » / « chloe ») : ils doivent être listés AVANT toute
-- fusion, et la fusion est volontairement laissée hors de ce script (trop destructive pour
-- être automatisée à l'aveugle). À exécuter d'abord en lecture :
--
--   SELECT event_id, normalized_name, count(*) AS n, array_agg(id ORDER BY id) AS ids
--     FROM participants
--    GROUP BY 1,2 HAVING count(*) > 1;
--
-- Puis, seulement si la liste est comprise, fusionner pour chaque groupe :
--   1) ré-attacher les votes du/la perdant(e) au gardé (en supprimant au préalable les
--      votes qui créeraient un doublon (option_id, participant_id)) ;
--   2) supprimer le/la perdant(e).
--
-- Ces contraintes ne devront être décommentées qu'une fois les doublons résorbés,
-- sinon la création d'index échouera.

/*
CREATE UNIQUE INDEX IF NOT EXISTS participants_event_name_key
  ON participants (event_id, normalized_name) WHERE normalized_name IS NOT NULL;

-- Un vote par (créneau, invité) : le « modifier mes disponibilités » devient un upsert idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS votes_option_participant_key
  ON votes (option_id, participant_id);
*/

-- ============================================================ 5. intégrité référentielle
-- (déjà partiellement en place d'après les payloads ; à vérifier avant d'ajouter)
/*
ALTER TABLE options      ADD CONSTRAINT options_event_id_fkey      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE participants ADD CONSTRAINT participants_event_id_fkey FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE tasks        ADD CONSTRAINT tasks_event_id_fkey        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE votes        ADD CONSTRAINT votes_participant_id_fkey  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE;
ALTER TABLE votes        ADD CONSTRAINT votes_option_id_fkey       FOREIGN KEY (option_id)      REFERENCES options(id)      ON DELETE CASCADE;
ALTER TABLE events       ADD CONSTRAINT events_final_option_id_fkey FOREIGN KEY (final_option_id) REFERENCES options(id) ON DELETE SET NULL;
*/

-- ============================================================ 6. contrat d'erreur
-- `?event_id=99999` renvoyait 200 [] alors que l'évènement n'existe pas : l'UI ne peut pas
-- distinguer « évènement inconnu » de « personne n'a encore voté ». Aucune migration
-- nécessaire (c'est du code applicatif), mais si vous voulez un garde-fou en base :
--   - la 404 doit venir du contrôleur, jamais d'un `[]` implicite.

COMMIT;
