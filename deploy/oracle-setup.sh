#!/usr/bin/env bash
# Prepara una VM Ubuntu (Oracle Cloud Always Free) para correr Orama's Detailing.
# Uso (en la VM, como el usuario "ubuntu"):   sudo bash oracle-setup.sh orama-detailing.duckdns.org
# Es idempotente: se puede ejecutar de nuevo. NO instala el código (eso es el paso de "subir la app" de docs/DESPLIEGUE-ORACLE.md)
# y NO contiene secretos: la clave de cifrado se genera aquí mismo y la contraseña de Gmail la escribes tú en el archivo de entorno.
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "Falta el dominio. Ejemplo: sudo bash oracle-setup.sh orama-detailing.duckdns.org"; exit 2; fi
if [ "$(id -u)" -ne 0 ]; then echo "Ejecuta con sudo."; exit 2; fi

echo "▶ 1/7 Memoria de apoyo (swap 1 GB: la VM gratuita tiene 1 GB de RAM)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "▶ 2/7 Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "▶ 3/7 Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update && apt-get install -y caddy
fi
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	@eventos path /api/eventos
	handle @eventos {
		reverse_proxy 127.0.0.1:8080 {
			flush_interval -1
		}
	}
	handle {
		encode zstd gzip
		reverse_proxy 127.0.0.1:8080
	}
}
EOF

echo "▶ 4/7 Firewall del sistema (las imágenes de Oracle bloquean 80/443 por defecto)"
# Las reglas deben quedar ANTES de la regla REJECT final de Oracle (si van después, nunca se aplican)
for p in 80 443; do
  iptables -C INPUT -m state --state NEW -p tcp --dport "$p" -j ACCEPT 2>/dev/null && continue
  N="$(iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
  iptables -I INPUT "${N:-1}" -m state --state NEW -p tcp --dport "$p" -j ACCEPT
done
apt-get install -y iptables-persistent >/dev/null 2>&1 || true
netfilter-persistent save 2>/dev/null || true

echo "▶ 5/7 Usuario, carpetas y servicio"
id orama >/dev/null 2>&1 || useradd --system --home /opt/orama --shell /usr/sbin/nologin orama
install -d -o orama -g orama /opt/orama /var/lib/orama /var/lib/orama/backups
install -d -m 750 -o root -g orama /etc/orama
cat > /etc/systemd/system/orama.service <<'EOF'
[Unit]
Description=Orama's Detailing (API + sitio)
After=network-online.target
Wants=network-online.target

[Service]
User=orama
WorkingDirectory=/opt/orama
EnvironmentFile=/etc/orama/orama.env
ExecStart=/usr/bin/node --no-warnings server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/orama
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo "▶ 6/7 Archivo de entorno (secretos): /etc/orama/orama.env"
if [ ! -f /etc/orama/orama.env ]; then
  KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
  cat > /etc/orama/orama.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8080
TRUST_PROXY=1
DATABASE_PATH=/var/lib/orama/orama.db
BACKUP_DIR=/var/lib/orama/backups
PUBLIC_BASE_URL=https://${DOMAIN}
DATA_ENCRYPTION_KEY=${KEY}
OWNER_EMAIL=oramasdetailing@gmail.com
GMAIL_USER=oramasdetailing@gmail.com
GMAIL_APP_PASSWORD=
EOF
  chown root:orama /etc/orama/orama.env && chmod 640 /etc/orama/orama.env
  echo
  echo "  ┌─ IMPORTANTE ───────────────────────────────────────────────────────────────┐"
  echo "  │ Se generó DATA_ENCRYPTION_KEY y quedó SOLO en /etc/orama/orama.env.         │"
  echo "  │ GUÁRDALA YA en un lugar seguro (gestor de contraseñas): sin ella los       │"
  echo "  │ datos de los clientes no se pueden recuperar. Para verla:                   │"
  echo "  │     sudo grep DATA_ENCRYPTION_KEY /etc/orama/orama.env                      │"
  echo "  │ Falta escribir GMAIL_APP_PASSWORD:  sudo nano /etc/orama/orama.env          │"
  echo "  └─────────────────────────────────────────────────────────────────────────────┘"
else
  echo "  (ya existía; no se toca)"
fi

echo "▶ 7/7 Habilitar servicios"
systemctl daemon-reload
systemctl enable orama caddy >/dev/null 2>&1
systemctl restart caddy
echo
echo "Listo. Siguiente paso: subir la app a /opt/orama y arrancar:  sudo systemctl start orama"
