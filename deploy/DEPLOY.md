# Guia de publicação do sistema (passo a passo para iniciantes)

Estimativa de custo: **R$ 30–50/mês** (VPS ~R$ 30 + domínio ~R$ 4 amortizado).
Tempo total: cerca de 1 a 2 horas no primeiro deploy.

O que cada peça faz, em uma linha:

| Nome | O que é |
|------|---------|
| **VPS** | Um computador na nuvem, sempre ligado, onde o sistema vai morar |
| **Domínio** | O endereço que as pessoas digitam (ex.: `loriangames.com.br`) |
| **Caddy** | Programa do servidor que entrega HTTPS automaticamente e repassa o tráfego ao sistema |
| **PM2** | Programa que mantém o Node rodando; relança sozinho se cair e liga junto com o servidor |
| **rclone** | Programa que envia os backups para o Google Drive |
| **SSH** | "Terminal remoto": você opera o VPS como se estivesse sentado na frente dele |

---

## Parte 1 — Criar o VPS

1. Crie uma conta na [DigitalOcean](https://www.digitalocean.com) (ou Contabo/Hetzner, mais baratos).
2. Crie um *Droplet* / servidor:
   - Imagem: **Ubuntu 24.04 LTS**
   - Tamanho: o mais barato serve com folga (1 GB de RAM, 1 vCPU)
   - Região: escolha **São Paulo** (menor latência)
   - Autenticação: escolha **senha** para simplificar (anote bem). De preferência depois mude para chave SSH.
3. Ao criar, anote o **IP público** (ex.: `164.90.100.20`). É ele que liga o domínio ao servidor.

## Parte 2 — Apontar o domínio para o VPS

No painel onde comprou o domínio (Registro.br, Hostinger...), procure **DNS** e crie um registro:

| Tipo | Nome | Valor |
|------|------|-------|
| A | `@` | O IP do seu VPS |

Se quiser também acessar por `www`, crie outro registro A com nome `www` e o mesmo IP.

A propagação demora de minutos a algumas horas. Teste depois com:

```
ping seudominio.com.br
```

Se responder com o IP certo, pronto.

## Parte 3 — Entrar no servidor (SSH)

No PowerShell do Windows:

```bash
ssh root@164.90.100.20
```

(usa o IP do seu VPS). Na primeira vez ele pede confirmação — digite `yes`. Depois digite a senha criada no painel do VPS. Você verá um terminal do Ubuntu.

## Parte 4 — Enviar os arquivos do sistema

1. No seu computador, copie a pasta do projeto **SOMENTE com o código** — pode excluir temporariamente `node_modules` e `backups` do pacote:

   **Opção simples (visual):** instale o [WinSCP](https://winscp.net), conecte com o IP e senha do VPS, e arraste a pasta do projeto para `/legiao` no servidor.

   **Opção com git (recomendada a longo prazo):** suba o projeto para um repositório privado do GitHub (o `.gitignore` já protege o `.env` e o banco) e clone no servidor:

   ```bash
   git clone https://github.com/SEU-USUARIO/legiao-games-sistema.git /legiao
   ```

2. O banco `legiao.sqlite` e o `.env` **não vão junto** (o git os ignora). Transfira o banco atual uma única vez, por WinSCP, colocando-o em `/legiao/legiao.sqlite`.

## Parte 5 — Instalar tudo no servidor

Dentro do SSH (ainda como root):

```bash
sudo bash /legiao/deploy/instalar-servidor.sh
```

Este script faz sozinho: fuso de São Paulo, atualização do Ubuntu, Node 22, PM2, Caddy e firewall (só SSH, HTTP 80 e HTTPS 443 abertos). Ao final ele imprime os próximos comandos — ou siga aqui:

```bash
cd /legiao
npm install
```

## Parte 6 — Configurar o `.env` no servidor

```bash
cp .env.example .env
nano .env
```

Preencha, **com valores novos e fortes** (a senha antiga do sistema local NÃO deve subir):

- `ADMIN_USER` — um login administrativo
- `ADMIN_PASS` — senha longa (10+ caracteres; gere com
  `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`)
- `ENCRYPTION_KEY` — a mesma do sistema local (tem péssima alternativa; se trocar aqui, logins de cliente precisam ser recadastrados)
- `TRUST_PROXY` — deixe em `1` (o Caddy está na frente). Trocar para `0` só se o Node aceitar conexões diretas da internet

Para salvar no `nano`: `Ctrl+O`, Enter, `Ctrl+X`.

## Parte 7 — Colocar o sistema de pé

```bash
cd /legiao
pm2 start server.js --name legiao
pm2 startup        # roda a linha de comando que ele imprimir na tela
pm2 save
```

Para conferir que subiu, dentro do próprio SSH:

```bash
curl -s http://localhost:3000 | head -c 200
```

Deve devolver o HTML da página (começa com `<!doctype html>`). A porta 3000 **não abre no navegador de fora** — o firewall a mantém fechada de propósito: o público entra pelo Caddy (Parte 8).

## Parte 8 — Ativar o HTTPS com o seu domínio

1. Edite a configuração do Caddy, trocando pelo domínio real:

```bash
nano /etc/caddy/Caddyfile
```

Apague o conteúdo e cole (com seu domínio, nas duas ocorrências):

```
seudominio.com.br {
	reverse_proxy localhost:3000
}
```

(Salvar: `Ctrl+O`, Enter, `Ctrl+X`.)

2. Recarregue e teste:

```bash
systemctl reload caddy
```

Abra **https://seudominio.com.br** no navegador — o Caddy pediu e instalou o certificado sozinho. Em ~1 minuto, cadeado verde.

## Parte 9 — Antes de divulgar o link (checklist)

- [ ] `.env` do servidor tem senha de admin **nova** (a antiga nunca foi enviada ao servidor)
- [ ] Login com a senha nova funciona; com a antiga, não
- [ ] Backup gerado em `/legiao/backups` (confira com `ls -lh /legiao/backups`)
- [ ] Um backup baixado e conferido — você sabe restaurá-lo se precisar
- [ ] DNS e HTTPS funcionando em celular **e** computador
- [ ] `IP:3000` **não** abre no navegador de fora — é o comportamento certinho

## Parte 10 — Manutenção do dia a dia

| Para... | Comando (via SSH) |
|---------|-------------------|
| Ver logs do sistema | `pm2 logs legiao --lines 50` |
| Reiniciar o sistema | `pm2 restart legiao` |
| Ver status | `pm2 status` |
| Atualizar para uma nova versão do código | suba os arquivos (WinSCP ou git), depois `pm2 restart legiao`. Prefira horário fechado — restauração de backup resolve os acidentes |
| Backup imediato | pelo painel administrativo: "Criar backup agora" |
| Backup na nuvem | veja a Parte 11 deste guia |

## Parte 11 — Backup na nuvem com rclone (recomendado)

```bash
apt-get install -y rclone
rclone config          # escolha "n" (novo remote), nome "gdrive", tipo "drive" e siga o assistente com sua conta Google
```

No final, adicione ao `/legiao/.env`:

```
RCLONE_REMOTE=gdrive:legiao-backups
```

E reinicie:

```bash
pm2 restart legiao
```

Com isso, cada backup gerado pelo sistema vai também para a sua conta Google Drive — se o VPS morrer, você recupera de lá pelo painel de restauração.

## Problemas comuns

**"connect ECONNREFUSED" no navegador** — o sistema não subiu: `pm2 logs legiao`.

**Cadeado não aparece / "SSL Timeout"** — DNS ainda propagando (`ping seudominio.com.br` ainda não responde com o IP certo) e o Caddy não conseguiu tirar o certificado. Espere e rode `systemctl reload caddy` de novo.

**"Connection timed out" em tudo** — firewall do VPS por dentro (DigitalOcean tem firewall opcional no painel) ou o `ufw` errado: confira `ufw status` (OpenSSH, 80 e 443 devem estar "ALLOW").

**Sistema desloga todo mundo de vez em quando** — sessões com expiração deslizante de 30 dias; se quiser mais, é só ajustar `SESSAO_DURACAO_MS` no `server.js`.
