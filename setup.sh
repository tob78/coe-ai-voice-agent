#!/bin/bash
# ================================================================
# 🚀 KI-Telefonassistent — Automatisk Setup
# Kjør dette scriptet på en FERSK Ubuntu/Debian-server
# Setter opp ALT automatisk på 5 minutter
# ================================================================

set -e

echo "🤖 KI-Telefonassistent Setup"
echo "=============================="
echo ""

# Sjekk at vi har root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Kjør som root: sudo bash setup.sh"
  exit 1
fi

# Spør om nødvendig info
read -p "🔑 OpenAI API-nøkkel: " OPENAI_KEY
read -p "📞 Twilio Account SID: " TWILIO_SID
read -p "📞 Twilio Auth Token: " TWILIO_TOKEN
read -p "📞 Twilio telefonnummer (f.eks. +12602612731): " TWILIO_PHONE
read -p "🗄️ Database-passord (velg selv): " DB_PASS
read -p "🌐 Domene (eller server-IP, f.eks. minserver.no): " DOMAIN

echo ""
echo "📦 Installerer programvare..."

# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs git nginx postgresql postgresql-contrib

# PostgreSQL
echo "🗄️ Setter opp database..."
sudo -u postgres psql -c "CREATE USER coe_user WITH PASSWORD '$DB_PASS';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE coe_db OWNER coe_user;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE coe_db TO coe_user;"

# Hent kode
echo "📥 Henter kode fra GitHub..."
mkdir -p /opt
cd /opt
if [ -d "coe-ai-voice-agent" ]; then
  cd coe-ai-voice-agent && git pull origin main
else
  git clone https://github.com/tob78/coe-ai-voice-agent.git
  cd coe-ai-voice-agent
fi

npm install

# Environment
echo "⚙️ Konfigurerer..."
cat > .env << EOF
DATABASE_URL=postgresql://coe_user:${DB_PASS}@localhost:5432/coe_db
OPENAI_API_KEY=${OPENAI_KEY}
TWILIO_ACCOUNT_SID=${TWILIO_SID}
TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}
TWILIO_PHONE_NUMBER=${TWILIO_PHONE}
PORT=3000
NODE_ENV=production
EOF

# PM2 for auto-restart
echo "🔄 Installerer prosesshåndtering..."
npm install -g pm2
pm2 delete coe-backend 2>/dev/null || true
pm2 start server.js --name coe-backend
pm2 startup
pm2 save

# Nginx
echo "🌐 Setter opp webserver..."
cat > /etc/nginx/sites-available/coe << NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 50M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/coe /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# HTTPS (bare hvis det er et domene, ikke IP)
if [[ ! "$DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "🔒 Setter opp HTTPS..."
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || echo "⚠️ HTTPS feilet — du kan kjøre 'certbot --nginx' manuelt senere"
fi

# Backup cron
echo "💾 Setter opp daglig backup..."
mkdir -p /opt/backups
(crontab -l 2>/dev/null; echo "0 3 * * * pg_dump postgresql://coe_user:${DB_PASS}@localhost:5432/coe_db > /opt/backups/coe_\$(date +\%Y\%m\%d).sql") | sort -u | crontab -

# Verifiser
echo ""
echo "✅ =============================="
echo "✅ SETUP FERDIG!"
echo "✅ =============================="
echo ""
echo "🌐 CRM:     http://${DOMAIN}/crm/"
echo "🏥 Helse:   http://${DOMAIN}/health"
echo "📊 Detalj:  http://${DOMAIN}/health/detailed"
echo ""
echo "📞 Neste steg:"
echo "   1. Gå til console.twilio.com"
echo "   2. Phone Numbers → +${TWILIO_PHONE}"
echo "   3. Sett webhook til: https://${DOMAIN}/twilio/voice"
echo "   4. Ring nummeret for å teste!"
echo ""
echo "🔧 Nyttige kommandoer:"
echo "   pm2 logs coe-backend    — se logger"
echo "   pm2 restart coe-backend — restart serveren"
echo "   /opt/deploy.sh          — oppdater fra GitHub"
echo ""

# Deploy-script
cat > /opt/deploy.sh << 'DEPLOY'
#!/bin/bash
cd /opt/coe-ai-voice-agent
git pull origin main
npm install
pm2 restart coe-backend
echo "✅ Deploy ferdig: $(date)"
DEPLOY
chmod +x /opt/deploy.sh
