#!/usr/bin/env bash
#
# A development certificate for reaching Manilla from a phone over the LAN.
#
# Passkeys need two things a LAN address cannot give: a secure origin, and a
# relying-party ID that is a domain name rather than an IP. This script produces
# the missing half - a tiny certificate authority, and a certificate for a LAN
# hostname signed by it. Trust the CA on the phone once and the origin is secure
# and named, so WebAuthn works with no Tailscale and no public domain.
#
#   bash scripts/dev-cert.sh [hostname] [ip]
#
# Everything lands in ./certs, which is gitignored: the CA key can mint a
# certificate for any name a device trusting it visits, so it stays on this
# machine.
#
# This is a development convenience. In production the certificate comes from
# `tailscale cert` and is trusted by every browser without installing anything.

set -euo pipefail

HOST="${1:-manilla.lan}"
IP="${2:-$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"

mkdir -p "$DIR"
cd "$DIR"

# Apple refuses to trust a server certificate valid for more than 825 days, so
# the leaf is deliberately shorter-lived than the CA.
CA_DAYS=3650
LEAF_DAYS=820

if [[ ! -f dev-ca.pem ]]; then
  echo "Creating a development CA"
  openssl req -x509 -newkey rsa:2048 -sha256 -days "$CA_DAYS" -nodes \
    -keyout dev-ca-key.pem -out dev-ca.pem \
    -subj "/CN=Manilla development CA/O=Manilla" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
else
  echo "Reusing the existing development CA (delete certs/dev-ca*.pem to start over)"
fi

echo "Issuing a certificate for $HOST${IP:+ and $IP}"
openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout dev-key.pem -out dev.csr -subj "/CN=$HOST" 2>/dev/null

SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1"
[[ -n "$IP" ]] && SAN="$SAN,IP:$IP"

openssl x509 -req -in dev.csr -CA dev-ca.pem -CAkey dev-ca-key.pem -CAcreateserial \
  -out dev-cert.pem -days "$LEAF_DAYS" -sha256 \
  -extfile <(
    printf 'subjectAltName=%s\n' "$SAN"
    printf 'basicConstraints=critical,CA:FALSE\n'
    printf 'keyUsage=critical,digitalSignature,keyEncipherment\n'
    printf 'extendedKeyUsage=serverAuth\n'
  ) 2>/dev/null

rm -f dev.csr

chmod 600 dev-ca-key.pem dev-key.pem

cat <<NOTES

Done. certs/
  dev-ca.pem       install and trust this one on the phone
  dev-ca-key.pem   never leaves this machine
  dev-cert.pem     the server certificate, for $HOST
  dev-key.pem      its key

Next:
  1. Point $HOST at $IP in whatever answers DNS on your network - a Pi-hole's
     Local DNS records, or the router's host table.
  2. Let the LAN reach the port:
       sudo ufw allow from 192.168.1.0/24 to any port ${MANILLA_PORT:-3001} proto tcp
  3. Put certs/dev-ca.pem on the phone and trust it. The easiest way is to open
     https://$HOST:${MANILLA_PORT:-3001}/api/dev-ca on the phone and accept the
     certificate warning once - downloading a file is not WebAuthn, so an
     untrusted connection is fine for that one step. Then:
       iOS      Install the downloaded profile, then switch it on under
                Settings -> General -> About -> Certificate Trust Settings.
                That second step is the one everyone forgets, and without it
                passkeys stay switched off.
       Android  Install it as a CA certificate (Settings -> Security ->
                Encryption & credentials -> Install a certificate).
       Firefox  Keeps its own store: import the CA into Firefox itself.
  4. Set these in .env, so the origin matches exactly:
       MANILLA_RP_ID=$HOST
       MANILLA_ORIGIN=https://$HOST:${MANILLA_PORT:-3001}
       MANILLA_DEV_ORIGINS=$HOST${IP:+,$IP}
  5. npm run dev:https

NOTES
