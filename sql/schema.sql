-- Dispoo V1 — schéma de référence (base neuve).
--
-- Bonne nouvelle : vous n'avez normalement PAS besoin d'exécuter ce fichier.
-- L'API applique ces mêmes instructions d'elle-même au premier appel
-- (`api/_lib/store.js`, `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`),
-- ce qui couvre aussi bien une base vierge qu'une base existante.
--
-- Ce fichier reste utile pour : inspecter le modèle, créer la base à la main,
-- ou alimenter un outil de migration. Exécution manuelle :
--   psql "$POSTGRES_URL" -f sql/schema.sql
--
-- Base existante (avant V1) : appliquez d'abord `v1-kit/sql/001_v1_hardening.sql`
-- (backfill des dates, séparation démo/réel), le schéma ci-dessous est compatible.

-- ================================================================ tables
CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  code            CHAR(6) NOT NULL,
  title           TEXT NOT NULL,
  location        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sondage' CHECK (status IN ('sondage', 'confirme')),
  final_option_id INTEGER NULL,
  owner_token_hash TEXT NULL,
  archived_at     TIMESTAMPTZ NULL,
  is_demo         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS events_code_key ON events (code);
CREATE INDEX IF NOT EXISTS events_created_at_desc ON events (created_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS events_owner_token_hash_idx ON events (owner_token_hash);

CREATE TABLE IF NOT EXISTS options (
  id         SERIAL PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  time_start TIME NOT NULL,
  time_end   TIME NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS options_event_id_idx ON options (event_id);

CREATE TABLE IF NOT EXISTS participants (
  id              SERIAL PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partiel (et non UNIQUE brut) pour rester compatible avec les bases
-- pré-V1 où `normalized_name` a été ajouté après coup et peut être NULL.
CREATE UNIQUE INDEX IF NOT EXISTS participants_event_name_key
  ON participants (event_id, normalized_name) WHERE normalized_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS participants_event_id_idx ON participants (event_id);

CREATE TABLE IF NOT EXISTS votes (
  id             SERIAL PRIMARY KEY,
  option_id      INTEGER NOT NULL REFERENCES options (id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
  value          TEXT NOT NULL CHECK (value IN ('yes', 'maybe', 'no')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS votes_option_participant_key
  ON votes (option_id, participant_id);
CREATE INDEX IF NOT EXISTS votes_participant_id_idx ON votes (participant_id);

-- ================================================================ migration douce (base pré-V1)
ALTER TABLE events ADD COLUMN IF NOT EXISTS owner_token_hash TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE events ADD COLUMN IF NOT EXISTS final_option_id INTEGER;
ALTER TABLE events       ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE options      ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE participants ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE votes        ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE participants ADD COLUMN IF NOT EXISTS normalized_name TEXT;

-- Backfill best-effort (aligné sur `normalizeName` de `api/_lib/guard.js`).
UPDATE participants
   SET normalized_name = regexp_replace(
         lower(translate(name, 'àáâãäåçèéêëìíîïðñòóôõöùúûüýÿ', 'aaaaaaceeeeiiiinoooooouuuuyy')),
         '[^a-z0-9]', '', 'g')
 WHERE normalized_name IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_final_option_id_fkey') THEN
    ALTER TABLE events ADD CONSTRAINT events_final_option_id_fkey
      FOREIGN KEY (final_option_id) REFERENCES options (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ================================================================ updated_at automatique
CREATE OR REPLACE FUNCTION dispoo_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'events_touch_updated_at') THEN
    CREATE TRIGGER events_touch_updated_at BEFORE UPDATE ON events
      FOR EACH ROW EXECUTE FUNCTION dispoo_touch_updated_at();
  END IF;
END $$;

-- ================================================================ ordre stable
-- Le tri de la liste ne doit plus jamais dépendre de l'ordre implicite de Postgres.
-- (Voir `v1-kit/sql/001_v1_hardening.sql` §1 pour le backfill des NULL sur base pré-V1.)
