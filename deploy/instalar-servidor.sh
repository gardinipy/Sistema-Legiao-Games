#!/bin/bash
# ============================================================
#  Instalação do servidor para o sistema de comandas.
#  Rode este script UMA VEZ, num servidor Ubuntu recém-criado,
#  como root:  sudo bash instalar-servidor.sh
# ============================================================
set -e

echo "== 1/7 Fuso horário de São Paulo (baseline dos relatórios) =="
timedatectl set-timezone America/Sao_Paulo

echo "== 2/7 Atualizando o sistema =="
apt-get update && apt-get upgrade -y

echo "== 3/7 Instalando Node.js 22 =="
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "== 4/7 Instalando PM2 (mantém o sistema rodando) =="
npm install -g pm2

echo "== 5/7 Instalando o Caddy (HTTPS automático) =="
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmour --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

echo "== 6/7 Firewall básico =="
apt-get install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
yes | ufw enable

echo "== 7/7 Concluído =="
echo ""
echo "O servidor está pronto. Próximos passos (veja o DEPLOY.md):"
echo "  1. Subir a pasta do sistema (sem node_modules)"
echo "  2. npm install dentro da pasta"
echo "  3. pm2 start server.js --name legiao"
echo "  4. pm2 startup  (rode o comando que ele imprimir)"
echo "  5. pm2 save"
echo "  6. Copiar deploy/Caddyfile para /etc/caddy/Caddyfile com o domínio real"
echo "  7. systemctl reload caddy"
