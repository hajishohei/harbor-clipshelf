#!/usr/bin/env bash
# Makes the self-signed code signing certificate for the Mac build.
#   bash scripts/make-signing-cert.sh <output folder>
# Writes cert.p12 and MAC_SIGNING_CERT.txt ("<password>:<base64 p12>"), the
# value to register as the MAC_SIGNING_CERT secret on GitHub.
# Keep it private: anyone with it can sign apps as "HarboR ClipShelf".
set -euo pipefail
OUT="${1:?output folder}"
mkdir -p "$OUT"
chmod 700 "$OUT"
OPENSSL=openssl
[ -x /usr/bin/openssl ] && [ "$(uname)" = "Darwin" ] && OPENSSL=/usr/bin/openssl
LEGACY=""
if "$OPENSSL" version | grep -q '^OpenSSL 3'; then LEGACY="-legacy"; fi
cat > "$OUT/cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = HarboR ClipShelf Code Signing
O = HarboR
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
  -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -config "$OUT/cert.cnf" 2>/dev/null
PASS="$("$OPENSSL" rand -hex 16)"
"$OPENSSL" pkcs12 -export $LEGACY -inkey "$OUT/key.pem" -in "$OUT/cert.pem" \
  -name "HarboR ClipShelf Code Signing" -out "$OUT/cert.p12" -passout "pass:$PASS"
printf '%s:%s' "$PASS" "$(base64 < "$OUT/cert.p12" | tr -d '\n')" > "$OUT/MAC_SIGNING_CERT.txt"
rm -f "$OUT/key.pem" "$OUT/cert.cnf"
echo "wrote $OUT/MAC_SIGNING_CERT.txt"
