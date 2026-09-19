#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$PROJECT_DIR/.env.server"

green='\033[0;32m'
yellow='\033[0;33m'
red='\033[0;31m'
reset='\033[0m'

info() { printf "%b%s%b\n" "$green" "$*" "$reset"; }
warn() { printf "%b%s%b\n" "$yellow" "$*" "$reset" >&2; }
fail() { printf "%bERROR: %s%b\n" "$red" "$*" "$reset" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Command '$1' belum tersedia."
}

prompt() {
  local label="$1" default_value="${2:-}" value
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " value
    printf '%s' "${value:-$default_value}"
  else
    read -r -p "$label: " value
    printf '%s' "$value"
  fi
}

prompt_required() {
  local label="$1" value=''
  while [[ -z "$value" ]]; do
    value="$(prompt "$label")"
    [[ -n "$value" ]] || warn "$label wajib diisi."
  done
  printf '%s' "$value"
}

prompt_secret() {
  local label="$1" value=''
  while [[ -z "$value" ]]; do
    read -r -s -p "$label: " value
    printf '\n' >&2
    [[ -n "$value" ]] || warn "$label wajib diisi."
  done
  printf '%s' "$value"
}

confirm() {
  local label="$1" default_answer="${2:-y}" answer
  local hint='[Y/n]'
  [[ "$default_answer" == 'n' ]] && hint='[y/N]'
  read -r -p "$label $hint: " answer
  answer="${answer:-$default_answer}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

assert_single_line() {
  local name="$1" value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$name tidak boleh mengandung baris baru."
}

normalize_phone() {
  printf '%s' "$1" | tr -cd '0-9,'
}

random_hex() {
  local byte_count="$1"
  od -An -N "$byte_count" -tx1 /dev/urandom | tr -d ' \n'
}

make_password_hash() {
  local password="$1"
  if command -v node >/dev/null 2>&1; then
    printf '%s' "$password" | node -e '
      const { randomBytes, scryptSync } = require("node:crypto");
      let password = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => password += chunk);
      process.stdin.on("end", () => {
        const salt = randomBytes(16).toString("hex");
        const hash = scryptSync(password + "kopsusren-app-2024", salt, 64).toString("hex");
        process.stdout.write(`${salt}:${hash}`);
      });
    '
    return
  fi

  # Node tidak wajib terpasang di host. Gunakan runtime image yang sama dengan aplikasi.
  printf '%s' "$password" | docker run --rm -i node:22-bookworm-slim node -e '
    const { randomBytes, scryptSync } = require("node:crypto");
    let password = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => password += chunk);
    process.stdin.on("end", () => {
      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(password + "kopsusren-app-2024", salt, 64).toString("hex");
      process.stdout.write(`${salt}:${hash}`);
    });
  '
}

printf '\nKopSusRen V2 — Setup Server Docker\n'
printf '==================================\n\n'

require_command docker
require_command od
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin belum tersedia."
docker info >/dev/null 2>&1 || fail "Docker daemon tidak dapat diakses. Cek service Docker atau izin user."

cd "$PROJECT_DIR"

if [[ -f "$ENV_FILE" ]]; then
  warn ".env.server sudah ada."
  if ! confirm "Buat ulang konfigurasi? File lama akan dibackup" n; then
    info "Konfigurasi lama dipertahankan."
    if confirm "Build dan nyalakan stack sekarang?" y; then
      docker compose --env-file "$ENV_FILE" config >/dev/null
      docker compose --env-file "$ENV_FILE" up -d --build
      docker compose --env-file "$ENV_FILE" ps
    fi
    exit 0
  fi
  backup_file="${ENV_FILE}.backup.$(date +%Y%m%d-%H%M%S)"
  cp -- "$ENV_FILE" "$backup_file"
  chmod 600 "$backup_file"
  warn "Backup dibuat: $(basename "$backup_file")"
fi

app_address="$(prompt 'Domain untuk HTTPS, atau :80 jika memakai IP' ':80')"
assert_single_line APP_ADDRESS "$app_address"
[[ "$app_address" =~ ^(:[0-9]+|[A-Za-z0-9.-]+(:[0-9]+)?)$ ]] || fail "Isi APP_ADDRESS dengan domain tanpa http/https, atau :80."

if [[ "$app_address" == ':80' ]]; then
  public_base_url="$(prompt_required 'URL publik server, contoh http://192.168.1.110 atau http://IP-PUBLIK')"
else
  public_base_url="https://${app_address}"
fi
public_base_url="${public_base_url%/}"
[[ "$public_base_url" =~ ^https?://[^[:space:]]+$ ]] || fail "URL publik harus diawali http:// atau https://."

database_url="$(prompt_secret 'DATABASE_URL Supabase')"
assert_single_line DATABASE_URL "$database_url"
[[ "$database_url" =~ ^postgres(ql)?:// ]] || fail "DATABASE_URL harus berupa URL PostgreSQL Supabase."

valid_username="$(prompt 'Username login web' 'shidqifa')"
[[ "$valid_username" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "Username hanya boleh berisi huruf, angka, titik, underscore, dan tanda minus."

admin_password="$(prompt_secret 'Buat password login web (minimal 10 karakter)')"
(( ${#admin_password} >= 10 )) || fail "Password login minimal 10 karakter. Jalankan ulang setup."
admin_password_confirm="$(prompt_secret 'Ulangi password login web')"
[[ "$admin_password" == "$admin_password_confirm" ]] || fail "Konfirmasi password tidak cocok. Jalankan ulang setup."

owner_numbers="$(normalize_phone "$(prompt 'Nomor WhatsApp owner (format 62, pisahkan koma jika lebih dari satu)' '6285175403169')")"
[[ "$owner_numbers" =~ ^62[0-9]+(,62[0-9]+)*$ ]] || fail "Nomor owner harus format 62xxxxxxxxxx."

pairing_number="$(normalize_phone "$(prompt_required 'Nomor WhatsApp yang akan menjadi bot (format 62xxxxxxxxxx)')")"
[[ "$pairing_number" =~ ^62[0-9]+$ ]] || fail "Nomor bot harus format 62xxxxxxxxxx."

groq_api_key="$(prompt_secret 'Groq API key')"
assert_single_line GROQ_API_KEY "$groq_api_key"
groq_model="$(prompt 'Model Groq' 'openai/gpt-oss-120b')"

default_qris_url="${public_base_url}/assets/qris-kopsusren.jpeg"
qris_image_url="$(prompt 'URL gambar QRIS' "$default_qris_url")"
assert_single_line QRIS_IMAGE_URL "$qris_image_url"
[[ "$qris_image_url" =~ ^https?://[^[:space:]]+$ ]] || fail "URL QRIS harus diawali http:// atau https://."

info "Membuat secret dan hash password..."
auth_secret="$(random_hex 48)"
wa_shared_secret="$(random_hex 48)"
password_hash="$(make_password_hash "$admin_password")"
unset admin_password admin_password_confirm

umask 077
env_tmp="$(mktemp "$PROJECT_DIR/.env.server.tmp.XXXXXX")"
trap 'rm -f -- "${env_tmp:-}"; unset database_url groq_api_key' EXIT

{
  printf 'APP_ADDRESS=%s\n' "$app_address"
  printf 'APP_ENV=production\n'
  printf 'DATABASE_URL=%s\n' "$database_url"
  printf 'VALID_USERNAME=%s\n' "$valid_username"
  printf 'AUTH_SECRET=%s\n' "$auth_secret"
  printf 'VALID_PASSWORD_HASH=%s\n' "$password_hash"
  printf 'WA_SHARED_SECRET=%s\n' "$wa_shared_secret"
  printf 'WA_OWNER_NUMBERS=%s\n' "$owner_numbers"
  printf 'WA_PAIRING_NUMBER=%s\n' "$pairing_number"
  printf 'LOG_LEVEL=info\n'
  printf 'GROQ_API_KEY=%s\n' "$groq_api_key"
  printf 'GROQ_MODEL=%s\n' "$groq_model"
  printf 'CHATBOT_V2_ENABLED=true\n'
  printf 'QRIS_IMAGE_URL=%s\n' "$qris_image_url"
} > "$env_tmp"

mv -- "$env_tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT
unset database_url groq_api_key auth_secret wa_shared_secret password_hash

info ".env.server berhasil dibuat dengan permission 600."
info "Memvalidasi Docker Compose..."
docker compose --env-file "$ENV_FILE" config >/dev/null
info "Konfigurasi Docker Compose valid."

if confirm "Build dan nyalakan web, WhatsApp gateway, dan proxy sekarang?" y; then
  docker compose --env-file "$ENV_FILE" up -d --build
  printf '\n'
  docker compose --env-file "$ENV_FILE" ps
  printf '\n'
  info "Stack sudah dinyalakan."
  printf 'Web: %s\n' "$public_base_url"
  printf 'Pantau pairing WhatsApp: docker compose --env-file .env.server logs -f gateway\n'
  printf 'Cek kesehatan web: curl -fsS %s/healthz\n' "$public_base_url"
else
  printf '\nNyalakan nanti dengan:\n'
  printf 'docker compose --env-file .env.server up -d --build\n'
fi
