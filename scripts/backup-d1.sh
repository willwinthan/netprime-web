#!/usr/bin/env bash
# Export D1 remote เป็นไฟล์ SQL ที่ backups/netprime-db-<timestamp>.sql
#   scripts/backup-d1.sh                  -> netprime-db (production)
#   scripts/backup-d1.sh --env staging    -> netprime-db-staging
# ตัวเลือก: BACKUP_BUCKET=<ชื่อ R2 bucket>  อัปโหลดสำเนาไป R2 (ควรเป็น bucket แยก ไม่ใช่ netprime-assets)
# ไฟล์ backup มีข้อมูลผู้ใช้และ password hash: backups/ ถูก .gitignore ไว้ ห้าม commit หรือแชร์
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRANGLER=(node "$ROOT/node_modules/wrangler/bin/wrangler.js")
CONFIG="$ROOT/backend/wrangler.jsonc"

ENV_NAME="production"
if [[ "${1:-}" == "--" ]]; then shift; fi
if [[ "${1:-}" == "--env" ]]; then ENV_NAME="${2:?ระบุชื่อ env เช่น --env staging}"; fi
case "$ENV_NAME" in
  production) DB="netprime-db"; ENV_ARGS=() ;;
  staging) DB="netprime-db-staging"; ENV_ARGS=(--env staging) ;;
  *) echo "Unknown env: $ENV_NAME" >&2; exit 1 ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$ROOT/backups"
chmod 700 "$ROOT/backups"
OUT="$ROOT/backups/$DB-$STAMP.sql"

echo "Exporting remote D1 $DB ($ENV_NAME) -> backups/$(basename "$OUT")"
"${WRANGLER[@]}" d1 export "$DB" --remote --config "$CONFIG" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} --output "$OUT"
chmod 600 "$OUT"

if [[ ! -s "$OUT" ]]; then echo "Export is empty: $OUT" >&2; exit 1; fi
TABLES="$(grep -c '^CREATE TABLE' "$OUT" || true)"
echo "OK: $(du -h "$OUT" | cut -f1), $TABLES tables"

if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  KEY="d1/$DB/$(basename "$OUT")"
  echo "Uploading to r2://$BACKUP_BUCKET/$KEY"
  "${WRANGLER[@]}" r2 object put "$BACKUP_BUCKET/$KEY" --file "$OUT" --remote --content-type application/sql
fi
