#!/usr/bin/env bash
# Dispoo V1 — test de production (read-only).
#
# N'ENVOIE QUE DES GET. Aucune écriture, aucune suppression. À faire tourner contre
# l'URL de production STABLE, jamais contre une preview *.vercel.app (le test
# « noindex/preview » ci-dessous est justement là pour le détecter).
#
#   bash verify-v1.sh https://dispoo.app
#   CODE=LEAHU8 bash verify-v1.sh https://dispoo.app     # pour tester le lookup par code
#   bash verify-v1.sh --html-only https://dispoo.app     # uniquement les checks du HTML/build
#
# Sortie : 0 = tout est passé. 1 = au moins un FAIL (donc V1 non validée).

set -uo pipefail

BASE="${2:-${1:-}}"
[ "${1:-}" = "--html-only" ] && { HTML_ONLY=1; BASE="${2:-}"; } || HTML_ONLY=0
BASE="${BASE%/}"
CODE="${CODE:-}"
TIMEOUT="${TIMEOUT:-25}"

if [ -z "$BASE" ] || ! printf '%s' "$BASE" | grep -qE '^https?://'; then
  echo "usage: bash verify-v1.sh [--html-only] https://<url-de-production>" >&2
  exit 2
fi

command -v curl >/dev/null 2>&1 || { echo "curl requis" >&2; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BODY="$TMP/body"; HDR="$TMP/hdr"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        → %s\n' "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# get <url> -> sets STATUS, CTYPE, and writes body to $BODY
get() {
  : > "$BODY"; : > "$HDR"
  STATUS="$(curl -sS -L -m "$TIMEOUT" -D "$HDR" -o "$BODY" -w '%{http_code}' "$1" 2>"$TMP/err" || echo 000)"
  CTYPE="$(grep -i '^content-type:' "$HDR" | tail -1 | tr -d '\r' | cut -d' ' -f2- | cut -d';' -f1)"
  return 0
}
hdr()  { grep -i "^$1:" "$HDR" | tail -1 | tr -d '\r' | cut -d' ' -f2-; }
has()  { grep -qiE "$1" "$BODY"; }

header_() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

header_ "Cible : $BASE"

# ═══════════════════════════════════════ 1. HTML / build propre
header_ "1. HTML de production (tooling de génération retiré, fr, partage)"
get "$BASE/"
if [ "$STATUS" = 200 ]; then ok "GET / → 200"; else bad "GET / → $STATUS" "la home doit répondre 200"; fi

if [ "$HTML_ONLY" = 0 ] || true; then
  for SIG in 'rrweb' '__arena_rec' 'arena:' 'Agon' 'Element Picker' 'data-source-loc' 'data-agon-source'; do
    if has "$SIG"; then bad "trace de tooling de génération : $SIG" "à retirer du build (voir docs/FRONT-ROUTING.md §1)"; else ok "absent du HTML : $SIG"; fi
  done
  if has 'cdn\.jsdelivr\.net'; then bad "dépendance CDN tierce dans le HTML (jsdelivr)"; else ok "aucun CDN tiers dans le HTML"; fi

  grep -qiE '<html[^>]*lang="fr"' "$BODY" && ok '<html lang="fr">' || bad '<html lang="fr">' "trouvé : $(grep -oiE '<html[^>]*>' "$BODY" | head -1)"
  for M in 'og:title' 'og:description' 'og:image' 'twitter:card' 'theme-color' 'rel="canonical"'; do
    has "$M" && ok "meta $M" || bad "meta $M" "sans og:image, le lien partagé est un rectangle gris dans WhatsApp/iMessage"
  done
  has 'name="viewport"' && ok "viewport" || bad "viewport" "sans lui, le mobile est zoomé de 3×"
fi

# ═══════════════════════════════════════ 2. Routing / rewrite
header_ "2. Routing — /e/{code} doit survivre au refresh"
for P in "/e/${CODE:-LEAHU8}" "/e/ABC123" "/e/BADCODE99"; do
  get "$BASE$P"
  case "$CTYPE" in
    *html*) [ "$STATUS" = 200 ] && ok "GET $P → 200 text/html (rewrite SPA OK)" || bad "GET $P → $STATUS" "attendu 200 + HTML : le lien envoyé à un invité ne doit jamais être un 404" ;;
    *)      bad "GET $P → $STATUS $CTYPE" "la rewrite ne couvre pas cette route (ou /api est avalé par erreur)" ;;
  esac
done
get "$BASE/robots.txt"; case "$STATUS" in 200|404) ok "GET /robots.txt → $STATUS (répondu par l'app, pas par Vercel)";; *) bad "GET /robots.txt → $STATUS";; esac

# ═══════════════════════════════════════ 3. L'API n'est pas cassée par la rewrite
header_ "3. Serverless — /api/* doit rester de l'API"
get "$BASE/api/events"
if [ "$STATUS" = 404 ] && has 'This page doesn'; then
  bad "GET /api/events → 404 Vercel natif" "la rewrite / vercel.json casse les fonctions serverless"
elif printf '%s' "$CTYPE" | grep -qi html; then
  bad "GET /api/events renvoie du HTML ($CTYPE)" "l'endpoint est mangé par la rewrite SPA"
else
  ok "GET /api/events → $STATUS $CTYPE (endpoint vivant)"
fi
get "$BASE/api/health"; [ "$STATUS" = 404 ] && skip "GET /api/health (absent — optionnel)" || ok "GET /api/health → $STATUS"

# ═══════════════════════════════════════ 4. Confidentialité (le 🔴 n°1)
header_ "4. Confidentialité — plus aucun listing public, plus d'énumération par id"
if [ "$HTML_ONLY" = 0 ]; then
  get "$BASE/api/events"
  if [ "$STATUS" = 200 ] && has '"code"'; then
    bad "GET /api/events (sans param) expose des événements complets" "c'était le trou n°1 de l'audit : la table entière, codes inclus"
  elif [ "$STATUS" = 401 ] || [ "$STATUS" = 403 ] || [ "$STATUS" = 400 ]; then
    ok "GET /api/events sans jeton → $STATUS (listing public fermé)"
  elif [ "$STATUS" = 200 ] && ! has '"code"'; then
    ok "GET /api/events → 200 mais sans données d'événement"
  else
    bad "GET /api/events → $STATUS" "vérifier manuellement"
  fi

  for i in 1 2 3; do
    get "$BASE/api/events?id=$i"
    if [ "$STATUS" = 200 ] && has '"code"'; then
      bad "GET /api/events?id=$i renvoie un événement complet" "les ids sont séquentiels : un simple +1 lit toute la base"
    else
      ok "GET /api/events?id=$i → $STATUS (énumération fermée)"
    fi
  done

  for EP in options participants votes; do
    get "$BASE/api/$EP?event_id=1"
    if [ "$STATUS" = 200 ]; then
      bad "GET /api/$EP?event_id=1 accessible sans code ni jeton" "à réserver au propriétaire (x-owner-token)"
    else
      ok "GET /api/$EP?event_id=1 → $STATUS"
    fi
  done

  get "$BASE/api/events"; has '"email"' && bad "le payload expose un champ email" || ok "aucun email dans le payload"
fi

# ═══════════════════════════════════════ 5. Validation & erreurs
header_ "5. Validation des entrées et messages d'erreur"
if [ "$HTML_ONLY" = 0 ]; then
  # Contrat volontairement tolérant sur l'ORDRE des contrôles : refuser une entrée invalide
  # (400) ou refuser l'accès d'abord (401/403) sont deux implémentations correctes.
  # Ce qui est un défaut : répondre 200 (l'UI ne peut pas distinguer) ou 500 (non géré).
  LEAKS="$TMP/leaks"; : > "$LEAKS"
  for Q in "event_id=abc" "event_id=2%20OR%201%3D1" "event_id=-1" "event_id=1e9"; do
    get "$BASE/api/options?$Q"
    cat "$BODY" >> "$LEAKS"
    case "$STATUS" in
      400|401|403|404) ok "GET /api/options?$Q → $STATUS (rejeté proprement)" ;;
      200)             bad "GET /api/options?$Q → 200" "entrée invalide acceptée : c'est ce qui a produit « QA Test Event »" ;;
      000)             bad "GET /api/options?$Q → réseau" "endpoint injoignable" ;;
      *)               bad "GET /api/options?$Q → $STATUS" "attendu 400 (ou 401/403 si l'auth passe avant)" ;;
    esac
  done
  LEAKFOUND=""
  for LEAK in 'invalid input syntax' 'type integer' 'PostgreSQL' 'SQLSTATE' 'relation "' 'column "' 'at Object'; do
    grep -qiE "$LEAK" "$LEAKS" && LEAKFOUND="$LEAK"
  done
  if [ -n "$LEAKFOUND" ]; then
    bad "fuite technique dans une réponse d'erreur : $LEAKFOUND" "masquer le driver (voir api/_lib/guard.js)"
  else
    ok "aucun message technique (Postgres/SQL/stack) renvoyé au client"
  fi

  get "$BASE/api/events?code=BAD123"
  if [ "$STATUS" = 404 ]; then ok "faux code → 404"; else bad "faux code → $STATUS" "attendu 404, pas 200"; fi
  if has '" introuvable"'; then bad "bug de chaîne encore présent : \" introuvable\""; else ok "bug \" introuvable\" corrigé"; fi
  has 'Événement introuvable' && ok "message humain en français (Événement introuvable)" \
    || bad "aucun message « Événement introuvable »" "l'invité doit comprendre sans console devtools"

  get "$BASE/api/options"
  case "$STATUS" in
    400|401|403) ok "paramètre manquant → $STATUS (rejeté, pas de 500)";;
    *) bad "paramètre manquant → $STATUS" "attendu 400 (ou 401/403)";;
  esac

  # Évènement inexistant : doit être distinguable de « aucun vote ».
  get "$BASE/api/options?event_id=99999&code=${CODE:-000000}"
  case "$STATUS" in
    404) ok "event_id inexistant → 404";;
    200) bad "event_id inexistant → 200 []" "l'UI ne peut pas distinguer « événement inconnu » de « aucun vote »";;
    *)   skip "event_id inexistant → $STATUS (à trancher : 404 attendu)";;
  esac
fi

# ═══════════════════════════════════════ 6. Cache & environnements
header_ "6. Cache, preview, cold start"
get "$BASE/api/events"
[ "$(hdr cache-control)" = "no-store" ] && ok "/api → cache-control: no-store" || bad "/api cache-control = '$(hdr cache-control)'" "un JSON d'événements caché = votes fantômes"
get "$BASE/"
NX="$(hdr x-robots-tag)"
case "$NX" in *noindex*) bad "x-robots-tag: noindex présent" "c'est une PREVIEW Vercel : l'URL meurt au déploiement suivant, donc tous les liens partagés meurent avec";; *) ok "pas de noindex (URL de production)";; esac
case "$BASE" in
  *"-vercel.app"*|*"vercel.app"*) skip "URL sur vercel.app : vérifier qu'il s'agit de l'alias de PRODUCTION (dispoo.vercel.app), pas d'une préversion";;
esac

C1=""; SAME=0
for i in 1 2 3; do
  get "$BASE/api/events${CODE:+?code=$CODE}"
  [ -n "$C1" ] && [ "$STATUS" = "$C1" ] && SAME=$((SAME+1))
  C1="$STATUS"
done
[ "$SAME" = 2 ] && ok "3 appels consécutifs → même statut ($C1) (cold start masqué)" || bad "statuts instables sur 3 appels ($C1)" "prévoir le retry client (FRONT-ROUTING §7)"

# ═══════════════════════════════════════ 7. Lookup par code (si fourni)
header_ "7. Lookup par code"
if [ -n "$CODE" ]; then
  get "$BASE/api/events?code=$CODE"
  if [ "$STATUS" = 200 ] && has "\"code\":\"$CODE"; then ok "GET /api/events?code=$CODE → 200 + code correct"; else bad "GET /api/events?code=$CODE → $STATUS" "la route invité ne peut pas charger l'événement"; fi
  has '"created_at":null' && bad "created_at encore à null" "le tri et l'onglet Passés restent faux (sql/001)" || ok "created_at renseigné"
  has '"final_option"' && ok "final_option présent dans le payload détail (écran résultat en 1 requête)" || skip "final_option absent du payload"
else
  skip "code non fourni : relancer avec CODE=XXXXXX pour tester le lookup"
fi

# ═══════════════════════════════════════ résumé
printf '\n\033[1m── Résumé\033[0m\n'
printf '  PASS %s   FAIL %s   SKIP %s\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" = 0 ]; then
  printf '\n  \033[32m✔ Vérification automatique OK.\033[0m Il reste les checks non automatisables :\n'
  printf '    création (2 créneaux min.), vote, modification du vote, confirmation, mobile 390 px,\n'
  printf '    aperçu réel du lien dans WhatsApp/iMessage. Voir docs/ACCEPTANCE.md.\n'
  exit 0
fi
printf '\n  \033[31m✘ %s échec(s) — V1 non validée.\033[0m\n' "$FAIL"
exit 1
