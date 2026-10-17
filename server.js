// config do ambiente (.env)
require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const { criarModuloBackup } = require("./backup");
const { gerarRelatorioBuffer } = require("./relatorio");

const PORT = Number(process.env.PORT) || 3000;

// sem isso o servidor não inicia; nada de valor padrão
const OBRIGATORIAS = ["ADMIN_USER", "ADMIN_PASS", "ENCRYPTION_KEY"];
const faltando = OBRIGATORIAS.filter((v) => !process.env[v]);
if (faltando.length) {
  console.error(
    `Variáveis de ambiente ausentes: ${faltando.join(", ")}. ` +
      "Copie .env.example para .env, preencha os valores e reinicie.",
  );
  process.exit(1);
}

// Senha de admin curta é a primeira coisa que um ataque de força bruta quebra.
// Não é permitido subir com senha fraca a menos que isso seja forçado.
if (process.env.ADMIN_PASS.length < 10 && process.env.PERMITIR_SENHA_FRACA !== "yes") {
  console.error(
    "ADMIN_PASS tem menos de 10 caracteres. Para publicar na internet, " +
      "use uma senha de 10+ caracteres. (Para ambiente local de teste, " +
      "defina PERMITIR_SENHA_FRACA=yes no .env — nunca em produção.)",
  );
  process.exit(1);
}

// Chave de criptografia muito curta reduz o espaço de força bruta
if (process.env.ENCRYPTION_KEY.length < 32) {
  console.error(
    "ENCRYPTION_KEY muito curta (mínimo 32 caracteres). " +
      "Gerar nova: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// Quantos proxies reversos estão na frente do servidor. Com Caddy (deploy
// padrão) é 1 — e é ele que escreve o IP real em X-Forwarded-For. Direto na
// internet, sem proxy, use TRUST_PROXY=0 no .env, senão um atacante pode
// forjar o header X-Forwarded-For e burlar o bloqueio de logins.
app.set("trust proxy", validarTrustProxy());

function validarTrustProxy() {
  const v = String(process.env.TRUST_PROXY ?? "1").trim();
  if (/^\d+$/.test(v)) return Math.max(0, Math.min(5, Number(v)));
  if (/^true$/i.test(v)) return true;
  console.warn("TRUST_PROXY inválido; usando 0 (sem proxy confiável).");
  return 0;
}

// CSP rigorosa: nenhum script inline, nada de handlers onclick no HTML, e
// o front nunca recebe HTML dinâmico não escapado.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
        "form-action": ["'self'"],
        "base-uri": ["'none'"],
        "object-src": ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: false },
  }),
);

app.use(express.json({ limit: "200kb" }));
app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1d",
    dotfiles: "ignore",
  }),
);

// API restrita à mesma origem; ORIGIN no .env libera outra (ex.: app externo)
if (process.env.ORIGIN)
  app.use(
    cors({
      origin: process.env.ORIGIN.split(",").map((o) => o.trim()),
      methods: ["GET", "POST", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  );

// Dados autenticados/acessos nunca devem ficar em cache intermediário
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Durante uma restauração de backup, pausa a API para ninguém gravar no meio
let emRestauracao = false;
app.use("/api", (req, res, next) => {
  if (emRestauracao && !req.path.startsWith("/admin") && !req.path.startsWith("/client-login"))
    return res
      .status(503)
      .json({
        error: "Restauração de backup em andamento. Tente em instantes.",
      });
  next();
});

const dbFile = path.join(__dirname, "legiao.sqlite");
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("Erro ao abrir SQLite:", err.message);
  } else {
    console.log("Conectado ao banco legiao.sqlite com sucesso.");
    criarTabelas();
  }
});

function criarTabelas() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL
        )`);
    db.run(`CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, credits TEXT DEFAULT '[]'
        )`);
    db.run(`CREATE TABLE IF NOT EXISTS client_logins (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            clientId INTEGER UNIQUE NOT NULL,
            loginHash TEXT UNIQUE NOT NULL,
            loginEncrypted TEXT NOT NULL,
            accessCodeEncrypted TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )`);
    db.run(`CREATE TABLE IF NOT EXISTS comandas (
            id INTEGER PRIMARY KEY AUTOINCREMENT, clientId INTEGER, items TEXT NOT NULL, 
            totalGeral REAL NOT NULL, observacao TEXT, data TEXT NOT NULL
        )`);
    db.run(`CREATE TABLE IF NOT EXISTS fiados (
            id INTEGER PRIMARY KEY AUTOINCREMENT, clientId INTEGER, name TEXT NOT NULL,
            quantity INTEGER NOT NULL, price REAL NOT NULL, data TEXT NOT NULL, status TEXT DEFAULT 'Pendente'
        )`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY, tipo TEXT NOT NULL, sid INTEGER NOT NULL,
            expiresAt INTEGER NOT NULL, createdAt INTEGER
        )`);
    // bancos criados antes da coluna createdAt ganham a coluna agora
    db.run(`ALTER TABLE sessions ADD COLUMN createdAt INTEGER`, () => {});
    db.run("SELECT 1", () => iniciarBackupsAutomaticos());
  });
}

function normalizarNome(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
function compararNomes(a, b) {
  const na = normalizarNome(a);
  const nb = normalizarNome(b);
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}

// JSON.parse que nunca lança
function parseJsonSeguro(texto, padrao = []) {
  try {
    const v = JSON.parse(texto ?? "null");
    return v === null || v === undefined ? padrao : v;
  } catch (e) {
    return padrao;
  }
}

// login/código do cliente ficam em AES-256-GCM
// (ENCRYPTION_KEY é validada no começo do arquivo; se trocar depois de já
// usar o sistema, os dados salvos ficam ilegíveis)
const CHAVE_AES = crypto.scryptSync(process.env.ENCRYPTION_KEY, "legiao-aes-v1", 32);
const CHAVE_HMAC = crypto.scryptSync(process.env.ENCRYPTION_KEY, "legiao-hmac-v1", 32);

function criptografar(texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", CHAVE_AES, iv);
  const enc = Buffer.concat([cipher.update(String(texto), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("hex")).join(":");
}

function descriptografar(payload) {
  try {
    const [iv, tag, enc] = String(payload)
      .split(":")
      .map((h) => Buffer.from(h, "hex"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", CHAVE_AES, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch (e) {
    return null;
  }
}

function hashLogin(login) {
  return crypto
    .createHmac("sha256", CHAVE_HMAC)
    .update(String(login).trim().toLowerCase())
    .digest("hex");
}

// Código de acesso: 4 a 6 caracteres alfanuméricos
const CODIGO_REGEX = /^[A-Za-z0-9]{4,6}$/;
function gerarCodigoAleatorio() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // sem 0/O/1/l/I
  let codigo = "";
  for (let i = 0; i < 6; i++) codigo += chars[crypto.randomInt(chars.length)];
  return codigo;
}

const SESSAO_DURACAO_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias (deslizante)
const SESSAO_TETO_MS = 90 * 24 * 60 * 60 * 1000;    // 90 dias (teto absoluto)

// Helpers: transformam a API de callbacks do sqlite3 em Promises
// (as sessões ficam gravadas no banco, então reiniciar o servidor não desloga ninguém)
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))),
  );
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve())),
  );
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

// O token enviado ao navegador nunca é gravado; só o SHA-256 dele.
// Roubo do arquivo do banco não entrega sessões prontas para uso.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function criarSessao(tipo, id) {
  const token = crypto.randomBytes(32).toString("hex");
  const agora = Date.now();
  await dbRun(
    `INSERT INTO sessions (token, tipo, sid, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)`,
    [hashToken(token), tipo, id, agora + SESSAO_DURACAO_MS, agora],
  );
  return token;
}

// Limpa de hora em hora as sessões vencidas
setInterval(() => {
  dbRun(`DELETE FROM sessions WHERE expiresAt < ?`, [Date.now()]).catch((e) =>
    console.error("Limpeza de sessões:", e.message),
  );
}, 60 * 60 * 1000);

function revogarSessoes(tipo, sid) {
  return dbRun(`DELETE FROM sessions WHERE tipo = ? AND sid = ?`, [tipo, sid]).catch(() => {});
}

function compararSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ""));
  const bufB = Buffer.from(String(b ?? ""));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function extrairToken(req) {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

async function authMiddleware(req, res, next) {
  const token = extrairToken(req);
  if (token) {
    try {
      const sess = await dbGet(`SELECT * FROM sessions WHERE token = ?`, [hashToken(token)]);
      const agora = Date.now();
      if (sess && sess.expiresAt > agora) {
        // Teto absoluto: sessão não vive forever só renovando
        const criado = sess.createdAt || agora;
        if (agora - criado > SESSAO_TETO_MS) {
          await dbRun(`DELETE FROM sessions WHERE token = ?`, [sess.token]).catch(() => {});
        } else {
          // Sessão deslizante: cada uso renova o prazo
          dbRun(`UPDATE sessions SET expiresAt = ? WHERE token = ?`, [
            agora + SESSAO_DURACAO_MS,
            sess.token,
          ]).catch(() => {});
          req.session = { tipo: sess.tipo, id: sess.sid };
          return next();
        }
      } else if (sess) {
        await dbRun(`DELETE FROM sessions WHERE token = ?`, [sess.token]).catch(() => {});
      }
    } catch (e) {
      return res.status(500).json({ error: "Erro ao validar sessão." });
    }
  }
  return res
    .status(401)
    .json({ error: "Sessão expirada ou inválida. Faça login novamente." });
}

function exigirTipo(tipo, mensagem) {
  return (req, res, next) =>
    authMiddleware(req, res, () => {
      if (req.session.tipo !== tipo) return res.status(403).json({ error: mensagem });
      next();
    });
}
const adminMiddleware = exigirTipo("admin", "Acesso de administrador necessário.");
const clientMiddleware = exigirTipo("client", "Acesso de cliente necessário.");

// por IP + tipo de login: 5 erros em 15 min bloqueiam por 15 min
const MAX_TENTATIVAS = 5;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;
const BLOQUEIO_MS = 15 * 60 * 1000;
const tentativasLogin = new Map(); // chave -> { falhas, primeiraFalha, bloqueadoAte }

function obterIp(req) {
  return req.ip || req.socket?.remoteAddress || "desconhecido";
}

// Limitador geral da API: sem isso, um script pode martelar rotas válidas
// (ex.: /api/comandas) milhares de vezes por segundo.
const LIMITA_API = { maximo: 600, janelaMs: 15 * 60 * 1000 };
const contadorApi = new Map(); // ip -> { n, primeira }
function limitadorApi(req, res, next) {
  const agora = Date.now();
  let r = contadorApi.get(obterIp(req));
  if (!r || agora - r.primeira > LIMITA_API.janelaMs) {
    r = { n: 1, primeira: agora };
  } else {
    r.n += 1;
  }
  contadorApi.set(obterIp(req), r);
  if (r.n > LIMITA_API.maximo)
    return res.status(429).json({ error: "Muitas requisições. Tente mais tarde." });
  next();
}
setInterval(() => {
  const agora = Date.now();
  for (const [ip, r] of contadorApi) {
    if (agora - r.primeira > LIMITA_API.janelaMs) contadorApi.delete(ip);
  }
}, 15 * 60 * 1000);

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function minutosBloqueado(chave) {
  const r = tentativasLogin.get(chave);
  const agora = Date.now();
  return r && r.bloqueadoAte && r.bloqueadoAte > agora
    ? Math.ceil((r.bloqueadoAte - agora) / 60000)
    : 0;
}
// devolve true se, com esta falha, o IP passou a ficar bloqueado
function registrarFalha(chave) {
  const agora = Date.now();
  let r = tentativasLogin.get(chave);
  if (!r || agora - r.primeiraFalha > JANELA_TENTATIVAS_MS) {
    r = { falhas: 1, primeiraFalha: agora, bloqueadoAte: null };
  } else {
    r.falhas += 1;
  }
  if (r.falhas >= MAX_TENTATIVAS) r.bloqueadoAte = agora + BLOQUEIO_MS;
  tentativasLogin.set(chave, r);
  return !!r.bloqueadoAte;
}
setInterval(() => {
  const agora = Date.now();
  for (const [chave, r] of tentativasLogin) {
    const livre = !r.bloqueadoAte || r.bloqueadoAte < agora;
    if (livre && agora - r.primeiraFalha > JANELA_TENTATIVAS_MS) tentativasLogin.delete(chave);
  }
}, 10 * 60 * 1000);

function responderFalhaLogin(res, chave, mensagem) {
  return registrarFalha(chave)
    ? res.status(429).json({ error: "Muitas tentativas erradas. Acesso bloqueado por 15 minutos." })
    : res.status(401).json({ error: mensagem });
}

const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;

app.use("/api", limitadorApi);

app.post("/api/login", async (req, res) => {
  const chave = "admin-" + obterIp(req);
  const min = minutosBloqueado(chave);
  if (min)
    return res
      .status(429)
      .json({ error: `Muitas tentativas erradas. Tente novamente em ${min} minuto(s).` });

  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) return res.status(400).json({ error: "Informe usuário e senha." });

  const ok = compararSeguro(usuario, ADMIN_USER) & compararSeguro(senha, ADMIN_PASS);
  if (!ok) {
    await aguardar(400);
    return responderFalhaLogin(res, chave, "Usuário ou senha incorretos.");
  }
  tentativasLogin.delete(chave);
  res.json({ success: true, token: await criarSessao("admin", 0), tipo: "admin" });
});

app.post("/api/client-login", (req, res) => {
  const chave = "client-" + obterIp(req);
  const min = minutosBloqueado(chave);
  if (min)
    return res
      .status(429)
      .json({ error: `Muitas tentativas erradas. Tente novamente em ${min} minuto(s).` });

  const { login, accessCode } = req.body || {};
  if (!login || !accessCode)
    return res.status(400).json({ error: "Informe login e código de acesso." });

  db.get(
    `SELECT cl.accessCodeEncrypted, c.id AS clientId, c.name
       FROM client_logins cl JOIN clients c ON c.id = cl.clientId
      WHERE cl.loginHash = ?`,
    [hashLogin(login)],
    async (err, row) => {
      if (err) return res.status(500).json({ error: "Erro no servidor." });

      const codigo = row ? descriptografar(row.accessCodeEncrypted) : null;
      if (!row || codigo === null || !compararSeguro(accessCode, codigo)) {
        await aguardar(400);
        return responderFalhaLogin(res, chave, "Login ou código incorretos.");
      }
      tentativasLogin.delete(chave);
      res.json({
        success: true,
        token: await criarSessao("client", row.clientId),
        tipo: "client",
        name: row.name,
      });
    },
  );
});

app.post("/api/logout", async (req, res) => {
  const token = extrairToken(req);
  if (token) {
    try {
      await dbRun(`DELETE FROM sessions WHERE token = ?`, [hashToken(token)]);
    } catch (e) {}
  }
  res.json({ success: true });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ ok: true, tipo: req.session.tipo, id: req.session.id });
});

app.get("/api/client/dados", clientMiddleware, async (req, res) => {
  try {
    const row = await dbGet(`SELECT id, name, credits FROM clients WHERE id = ?`, [
      req.session.id,
    ]);
    if (!row) return res.status(404).json({ error: "Cliente não encontrado." });
    const credits = Array.isArray(parseJsonSeguro(row.credits, []))
      ? parseJsonSeguro(row.credits, [])
      : [];
    const hoje = new Date();
    const saldo = credits
      .filter((cr) => cr.amount >= 1 && new Date(cr.expiresAt) > hoje)
      .reduce((soma, cr) => soma + cr.amount, 0);
    res.json({ id: row.id, name: row.name, saldo, credits });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao carregar seus dados." });
  }
});

app.get("/api/client/historico", clientMiddleware, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM comandas WHERE clientId = ? ORDER BY data DESC LIMIT 50`,
      [req.session.id],
    );
    res.json(
      rows.map((c) => ({
        id: c.id,
        items: parseJsonSeguro(c.items),
        totalGeral: c.totalGeral,
        observacao: c.observacao,
        data: c.data,
      })),
    );
  } catch (e) {
    return res.status(500).json({ error: "Erro ao carregar histórico." });
  }
});

// (login, logout, /api/me e as rotas /api/client/* ficam acima desta linha)
app.use("/api", adminMiddleware);

app.get("/api/products", async (req, res) => {
  try {
    res.json(await dbAll(`SELECT * FROM products`, []));
  } catch (e) {
    res.status(500).json({ error: "Erro ao carregar produtos." });
  }
});
app.post("/api/products", async (req, res) => {
  const nome = String((req.body || {}).name || "").trim();
  const preco = Number((req.body || {}).price);
  if (!nome) return res.status(400).json({ error: "Informe o nome do produto." });
  if (nome.length > 120)
    return res.status(400).json({ error: "Nome muito longo (máx. 120 caracteres)." });
  if (!Number.isFinite(preco) || preco < 0 || preco > 1000000)
    return res
      .status(400)
      .json({ error: "Informe um preço válido (número entre R$ 0 e R$ 1.000.000)." });
  try {
    await dbRun(`INSERT INTO products (name, price) VALUES (?, ?)`, [nome, preco]);
    const novo = await dbGet(`SELECT id FROM products ORDER BY id DESC LIMIT 1`);
    res.json({ id: novo ? novo.id : null, name: nome, price: preco });
  } catch (e) {
    res.status(500).json({ error: "Erro ao salvar o produto." });
  }
});
app.put("/api/products/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "Id inválido." });
  const nome = String((req.body || {}).name || "").trim();
  const preco = Number((req.body || {}).price);
  if (!nome) return res.status(400).json({ error: "Informe o nome do produto." });
  if (nome.length > 120)
    return res.status(400).json({ error: "Nome muito longo (máx. 120 caracteres)." });
  if (!Number.isFinite(preco) || preco < 0 || preco > 1000000)
    return res
      .status(400)
      .json({ error: "Informe um preço válido (número entre R$ 0 e R$ 1.000.000)." });
  db.run(`UPDATE products SET name = ?, price = ? WHERE id = ?`, [nome, preco, id], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao salvar o produto." });
    if (this.changes === 0) return res.status(404).json({ error: "Produto não encontrado." });
    res.json({ success: true });
  });
});
app.delete("/api/products/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    return res.status(400).json({ error: "Id inválido." });
  db.run(`DELETE FROM products WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao excluir o produto." });
    if (this.changes === 0)
      return res.status(404).json({ error: "Produto não encontrado." });
    res.json({ success: true });
  });
});

app.get("/api/clients", (req, res) => {
  db.all(
    `SELECT c.*, (cl.clientId IS NOT NULL) AS temLogin
       FROM clients c LEFT JOIN client_logins cl ON cl.clientId = c.id
      ORDER BY c.name`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro ao carregar clientes." });
      const clients = rows.map((c) => {
        let parsedCredits = parseJsonSeguro(c.credits, []);
        if (!Array.isArray(parsedCredits)) parsedCredits = [];
        return {
          id: c.id,
          name: c.name,
          temLogin: !!c.temLogin,
          credits: parsedCredits,
        };
      });
      res.json(clients);
    },
  );
});
app.post("/api/clients", (req, res) => {
  const nome = String((req.body || {}).name || "").trim();
  if (!nome) return res.status(400).json({ error: "Informe o nome do cliente." });
  if (nome.length > 80)
    return res.status(400).json({ error: "Nome muito longo (máx. 80 caracteres)." });
  db.run(`INSERT INTO clients (name, credits) VALUES (?, '[]')`, [nome], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao salvar o cliente." });
    res.json({ id: this.lastID, name: nome, credits: [] });
  });
});

function idValido(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

function clienteExiste(id, cb) {
  db.get(`SELECT id FROM clients WHERE id = ?`, [id], (err, row) => cb(!err && !!row));
}

// Ver login + código atuais
app.get("/api/admin/clients/:id/login", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  db.get(
    `SELECT loginEncrypted, accessCodeEncrypted FROM client_logins WHERE clientId = ?`,
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ error: "Erro no servidor." });
      if (!row) return res.json({ configurado: false });
      res.json({
        configurado: true,
        login: descriptografar(row.loginEncrypted),
        accessCode: descriptografar(row.accessCodeEncrypted),
      });
    },
  );
});

// Vincular / alterar login e código
app.put("/api/admin/clients/:id/login", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  const login = String((req.body || {}).login || "").trim();
  const accessCode = String((req.body || {}).accessCode || "").trim();
  if (login.length < 3 || login.length > 60)
    return res.status(400).json({ error: "O login deve ter entre 3 e 60 caracteres." });
  if (!CODIGO_REGEX.test(accessCode))
    return res
      .status(400)
      .json({ error: "O código deve ter de 4 a 6 caracteres (apenas letras e números)." });

  clienteExiste(id, (existe) => {
    if (!existe) return res.status(404).json({ error: "Cliente não encontrado." });
    db.run(
      `INSERT INTO client_logins (clientId, loginHash, loginEncrypted, accessCodeEncrypted, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(clientId) DO UPDATE SET
         loginHash = excluded.loginHash,
         loginEncrypted = excluded.loginEncrypted,
         accessCodeEncrypted = excluded.accessCodeEncrypted,
         updatedAt = excluded.updatedAt`,
      [id, hashLogin(login), criptografar(login), criptografar(accessCode), new Date().toISOString()],
      (err) => {
        if (err) {
          if (/UNIQUE/i.test(err.message))
            return res.status(400).json({ error: "Este login já está em uso por outro cliente." });
          return res.status(500).json({ error: "Erro ao salvar o acesso." });
        }
        // acessos mudaram: sessões antigas deste cliente perdem a validade
        revogarSessoes("client", id);
        res.json({ success: true });
      },
    );
  });
});

// Resetar: gera um novo código aleatório (o login continua o mesmo)
app.post("/api/admin/clients/:id/reset-code", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  const codigo = gerarCodigoAleatorio();
  db.run(
    `UPDATE client_logins SET accessCodeEncrypted = ?, updatedAt = ? WHERE clientId = ?`,
    [criptografar(codigo), new Date().toISOString(), id],
    function (err) {
      if (err) return res.status(500).json({ error: "Erro ao resetar o código." });
      if (this.changes === 0)
        return res.status(404).json({ error: "Este cliente ainda não tem login configurado." });
      // o código antigo deixa de valer: as sessões abertas também caem
      revogarSessoes("client", id);
      res.json({ success: true, accessCode: codigo });
    },
  );
});

// Remover o acesso do cliente
app.delete("/api/admin/clients/:id/login", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  db.run(`DELETE FROM client_logins WHERE clientId = ?`, [id], (err) => {
    if (err) return res.status(500).json({ error: "Erro ao remover o acesso." });
    revogarSessoes("client", id);
    res.json({ success: true });
  });
});

// Valores monetários: limites razoáveis que impedem números absurdos
const VALOR_MAX = 1000000;
function creditoValida(cr) {
  const amount = Number(cr && cr.amount);
  const exp = new Date(cr && cr.expiresAt).getTime();
  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= VALOR_MAX &&
    Number.isFinite(exp) &&
    exp > Date.now() - 24 * 60 * 60 * 1000 &&
    exp < Date.now() + 50 * 365 * 24 * 60 * 60 * 1000
  );
}
function limparCreditsCliente(credits) {
  if (!Array.isArray(credits)) return null;
  if (credits.length > 400) return null;
  const limpas = credits.map((cr) => ({
    amount: Number(cr && cr.amount),
    expiresAt: String((cr && cr.expiresAt) || ""),
  }));
  return limpas.every(creditoValida) ? limpas : null;
}

app.post("/api/clients/:id/addCredit", async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  const body = req.body || {};
  const valor = Number(body.amount);
  if (!Number.isFinite(valor) || valor <= 0 || valor > VALOR_MAX)
    return res
      .status(400)
      .json({ error: `Valor de crédito inválido (enter 0 e R$ ${VALOR_MAX.toLocaleString("pt-BR")}).` });
  const exp = new Date(body.expiresAt).getTime();
  if (
    !body.expiresAt ||
    !Number.isFinite(exp) ||
    exp < Date.now() - 24 * 60 * 60 * 1000 ||
    exp > Date.now() + 50 * 365 * 24 * 60 * 60 * 1000
  )
    return res.status(400).json({ error: "Data de validade inválida." });
  try {
    const row = await dbGet(`SELECT credits FROM clients WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: "Cliente não encontrado." });
    const credits = parseJsonSeguro(row.credits, []);
    if (!Array.isArray(credits)) return res.status(500).json({ error: "Dados de crédito inválidos." });
    if (credits.length >= 400)
      return res.status(400).json({ error: "Este cliente já tem créditos demais." });
    credits.push({ amount: valor, expiresAt: body.expiresAt });
    await dbRun(`UPDATE clients SET credits = ? WHERE id = ?`, [JSON.stringify(credits), id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao adicionar crédito." });
  }
});
app.put("/api/clients/:id/credits", async (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  const credits = limparCreditsCliente((req.body || {}).credits);
  if (!credits)
    return res
      .status(400)
      .json({ error: "Lista de créditos inválida (máx. 400, valores ≤ R$ 1.000.000)." });
  try {
    await dbRun(`UPDATE clients SET credits = ? WHERE id = ?`, [
      JSON.stringify(credits),
      id,
    ]);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao salvar os créditos." });
  }
});
app.delete("/api/clients/:id", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  db.get(`SELECT COUNT(*) AS n FROM fiados WHERE clientId = ? AND status = 'Pendente'`, [id], (err, row) => {
    if (err || !row) return res.status(500).json({ error: "Erro no servidor." });
    if (row.n > 0)
      return res
        .status(400)
        .json({ error: "Cliente tem fiado pendente. Quite antes de excluir." });
    // A comanda pode ter sido aberta em outra sessão; confere no servidor também
    if (lerAbertas()[String(id)])
      return res.status(400).json({
        error: "Cliente tem comanda aberta. Finalize ou cancele antes de excluir.",
      });
    db.run(`DELETE FROM client_logins WHERE clientId = ?`, [id]);
    db.run(`DELETE FROM sessions WHERE tipo = 'client' AND sid = ?`, [id]);
    db.run(`DELETE FROM clients WHERE id = ?`, [id], (err2) => {
      if (err2) return res.status(500).json({ error: "Erro ao excluir o cliente." });
      res.json({ success: true });
    });
  });
});

const DATA_FILE = path.join(__dirname, "comandas_abertas.json");

function lerAbertas() {
  try {
    const v = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}
// grava num .tmp e troca pelo arquivo real; queda de luz não corrompe nada
function salvarAbertas(dados) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// Formas de pagamento válidas — qualquer coisa fora da lista é recusada
const PAGAMENTOS_VALIDOS = new Set([
  "Dinheiro",
  "PIX",
  "Cartao de Credito",
  "Cartao de Debito",
  "Credito",
  "Fiado",
]);

// Devolve a comanda sanitizada ou null se houver algo inválido nela
function validarComanda(estado) {
  if (!estado || typeof estado !== "object") return null;
  const items = Array.isArray(estado.items) ? estado.items : [];
  if (items.length > 200) return null;
  const observacao = String(estado.observacao || "");
  if (observacao.length > 500) return null;
  const limpos = [];
  for (const i of items) {
    const name = String((i && i.name) || "").trim();
    const price = Number(i && i.price);
    const quantity = Number(i && i.quantity);
    const pagto = String((i && i.paymentMethod) || "");
    if (!name || name.length > 120) return null;
    if (!Number.isFinite(price) || price < 0 || price > VALOR_MAX) return null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
    if (pagto !== "" && !PAGAMENTOS_VALIDOS.has(pagto)) return null;
    const productId = Number(i && i.productId);
    limpos.push({
      productId: Number.isInteger(productId) && productId > 0 ? productId : null,
      name,
      price,
      quantity,
      paymentMethod: pagto,
    });
  }
  return { items: limpos, observacao };
}

// A gravação é sempre por cliente ("merge"): nunca substitui comandas
// abertas de outros operadores.
app.post("/api/comandas-abertas", (req, res) => {
  const body = req.body || {};
  if (body.__modo !== "merge")
    return res
      .status(400)
      .json({ error: "Formato não suportado. Use { __modo: 'merge', clientId, estado }." });
  const clientId = Number(body.clientId);
  if (!Number.isInteger(clientId) || clientId <= 0)
    return res.status(400).json({ error: "clientId ausente ou inválido." });

  const estado = validarComanda(body.estado);
  const abertas = lerAbertas();
  if (body.estado === null) {
    delete abertas[String(clientId)];
  } else if (estado) {
    abertas[String(clientId)] = estado;
  } else {
    return res.status(400).json({ error: "Formato de comanda inválido." });
  }
  try {
    salvarAbertas(abertas);
  } catch (e) {
    return res.status(500).json({ error: "Não foi possível salvar no servidor." });
  }
  res.json({ success: true });
});

app.get("/api/comandas-abertas", (req, res) => {
  res.json(lerAbertas());
});

app.get("/api/fiados", (req, res) => {
  db.all(`SELECT * FROM fiados WHERE status = 'Pendente'`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: "Erro ao carregar fiados." });
    res.json(rows);
  });
});
app.put("/api/fiados/pagar/:id", (req, res) => {
  const id = idValido(req.params.id);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  db.run(`UPDATE fiados SET status = 'Pago' WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: "Erro ao quitar o fiado." });
    if (this.changes === 0) return res.status(404).json({ error: "Fiado não encontrado." });
    res.json({ success: true });
  });
});
app.put("/api/fiados/pagar-cliente/:clientId", (req, res) => {
  const id = idValido(req.params.clientId);
  if (!id) return res.status(400).json({ error: "Id inválido." });
  db.run(
    `UPDATE fiados SET status = 'Pago' WHERE clientId = ? AND status = 'Pendente'`,
    [id],
    (err) => {
      if (err) return res.status(500).json({ error: "Erro ao quitar os fiados." });
      res.json({ success: true });
    },
  );
});

// Histórico: busca por nome no servidor (LIKE), sem carregar a tabela inteira
app.get("/api/comandas", (req, res) => {
  const params = [];
  let where = "";
  const q = String(req.query.q || "").trim();
  if (q) {
    if (q.length > 80) return res.status(400).json({ error: "Busca muito longa." });
    where = " WHERE cl.name LIKE ? ESCAPE '\\'";
    params.push("%" + q.replace(/[\\%_]/g, "\\$&") + "%");
  }
  const inicio = String(req.query.inicio || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    where += (where ? " AND" : " WHERE") + " c.data >= ?";
    params.push(inicio);
  }
  const limite = parseInt(req.query.limite, 10);
  let limitSql = "";
  if (Number.isInteger(limite) && limite > 0 && limite <= 5000) {
    limitSql = " LIMIT ?";
    params.push(limite);
  }
  db.all(
    `SELECT c.id, c.clientId, c.items, c.totalGeral, c.observacao, c.data, cl.name AS clienteNome
       FROM comandas c LEFT JOIN clients cl ON cl.id = c.clientId
      ${where} ORDER BY c.data DESC${limitSql}`,
    params,
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Erro ao carregar o histórico." });
      res.json(
        rows.map((c) => ({
          id: c.id,
          clientId: c.clientId,
          cliente: c.clienteNome || null, // null = cliente apagado no passado
          items: parseJsonSeguro(c.items),
          totalGeral: c.totalGeral,
          observacao: c.observacao,
          data: c.data,
        })),
      );
    },
  );
});

// Finalizar comanda: valida, desconta crédito, registra fiados e
// fecha a comanda aberta no arquivo — tudo dentro de uma transação:
// ou grava tudo, ou nada (nunca crédito descontado sem comanda).
let comandasDesdeBackup = 0;

app.post("/api/comandas/finalizar", async (req, res) => {
  const bruto = req.body || {};
  if (!bruto.clientId || !Array.isArray(bruto.items) || bruto.items.length === 0)
    return res.status(400).json({ error: "Dados incompletos." });
  if (bruto.items.length > 100)
    return res.status(400).json({ error: "A comanda tem itens demais." });
  const comanda = validarComanda(bruto);
  if (!comanda || comanda.items.length === 0)
    return res.status(400).json({ error: "Item inválido na comanda." });
  if (comanda.items.some((i) => i.paymentMethod === ""))
    return res.status(400).json({ error: "Selecione o pagamento de todos os produtos." });

  const clientId = idValido(bruto.clientId);
  if (!clientId) return res.status(400).json({ error: "Cliente inválido." });

  const totalGeral = comanda.items.reduce(
    (s, i) => s + i.price * i.quantity,
    0,
  );
  if (!Number.isFinite(totalGeral) || totalGeral > VALOR_MAX * 10)
    return res.status(400).json({ error: "Valor total inválido." });

  const creditosUsados = comanda.items
    .filter((i) => i.paymentMethod === "Credito")
    .reduce((s, i) => s + i.price * i.quantity, 0);

  const dataAtual = new Date().toISOString();

  try {
    await dbRun(`BEGIN IMMEDIATE`);
    try {
      const cliente = await dbGet(`SELECT id, credits FROM clients WHERE id = ?`, [clientId]);
      if (!cliente) {
        throw { status: 404, msg: "Cliente não encontrado." };
      }

      if (creditosUsados > 0) {
        const credits = Array.isArray(parseJsonSeguro(cliente.credits, []))
          ? parseJsonSeguro(cliente.credits, [])
          : [];
        let restante = creditosUsados;
        const hoje = Date.now();
        for (const cr of credits) {
          if (restante > 0 && new Date(cr.expiresAt).getTime() > hoje && cr.amount > 0) {
            if (cr.amount >= restante) {
              cr.amount -= restante;
              restante = 0;
            } else {
              restante -= cr.amount;
              cr.amount = 0;
            }
          }
        }
        if (restante > 0)
          throw {
            status: 400,
            msg: `Créditos insuficientes. Faltam R$ ${restante.toFixed(2)}.`,
          };
        await dbRun(`UPDATE clients SET credits = ? WHERE id = ?`, [
          JSON.stringify(credits),
          clientId,
        ]);
      }

      const nova = await dbRun(
        `INSERT INTO comandas (clientId, items, totalGeral, observacao, data) VALUES (?, ?, ?, ?, ?)`,
        [clientId, JSON.stringify(comanda.items), totalGeral, comanda.observacao || "", dataAtual],
      );

      for (const i of comanda.items.filter((i) => i.paymentMethod === "Fiado")) {
        await dbRun(
          `INSERT INTO fiados (clientId, name, quantity, price, data) VALUES (?, ?, ?, ?, ?)`,
          [clientId, i.name, i.quantity, i.price, dataAtual],
        );
      }

      await dbRun(`COMMIT`);

      // fecha a comanda aberta deste cliente (arquivo)
      try {
        const abertas = lerAbertas();
        delete abertas[String(clientId)];
        salvarAbertas(abertas);
      } catch (e) {}

      // backup extra a cada 25 comandas
      comandasDesdeBackup += 1;
      if (comandasDesdeBackup >= 25) {
        comandasDesdeBackup = 0;
        backup
          .criar()
          .then((nome) => console.log("Backup periódico criado:", nome))
          .catch((e) => console.error("Falha no backup periódico:", e.message));
      }

      return res.json({ success: true });
    } catch (e) {
      await dbRun(`ROLLBACK`).catch(() => {});
      if (e && e.status && e.msg) return res.status(e.status).json({ error: e.msg });
      throw e;
    }
  } catch (e) {
    if (!e || !e.status)
      console.error("Erro ao finalizar comanda:", e && e.message);
    return res.status(500).json({ error: "Erro ao finalizar a comanda." });
  }
});

// Relatório Excel gerado pelo próprio Node (exceljs), sem executar
// comandos externos.
app.get("/api/relatorio/excel", async (req, res) => {
  try {
    const buffer = await gerarRelatorioBuffer(db);
    res.set({
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="Relatorio_Completo_Legiao_Games.xlsx"',
    });
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error("Erro ao gerar relatório:", e && e.message);
    res.status(500).json({ error: "Erro ao gerar o relatório Excel." });
  }
});

const backup = criarModuloBackup({
  db,
  dataFile: DATA_FILE,
  dir: process.env.BACKUP_DIR || undefined,
});

const diaLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function backupDiarioSeNecessario() {
  if (emRestauracao) return;
  const hoje = diaLocal(new Date());
  const jaTem = backup.listar().some((b) => diaLocal(new Date(b.data)) === hoje);
  if (jaTem) return;
  backup
    .criar()
    .then((nome) => console.log("Backup diário criado:", nome))
    .catch((e) => console.error("Falha no backup diário:", e.message));
}

function iniciarBackupsAutomaticos() {
  backupDiarioSeNecessario();
  setInterval(backupDiarioSeNecessario, 60 * 60 * 1000);
}

async function executarRestauracao(arquivo, res) {
  // uma restauração por vez: duas simultâneas corrompem o banco
  if (emRestauracao)
    return res.status(409).json({ error: "Já existe uma restauração em andamento." });
  emRestauracao = true;
  try {
    await backup.restaurar(arquivo);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    emRestauracao = false;
  }
}

app.get("/api/admin/backups", (req, res) => res.json(backup.listar()));

// Como está o envio externo (rclone), se configurado
app.get("/api/admin/backups/externo", (req, res) => res.json(backup.statusExterno()));

app.post("/api/admin/backups", async (req, res) => {
  if (emRestauracao)
    return res.status(409).json({ error: "Restauração em andamento. Aguarde." });
  try {
    res.json({ success: true, nome: await backup.criar() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/backups/:nome/download", (req, res) => {
  try {
    const arq = backup.caminho(req.params.nome);
    if (!fs.existsSync(arq)) return res.status(404).json({ error: "Backup não encontrado." });
    res.download(arq);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/admin/backups/:nome/restaurar", async (req, res) => {
  let arq;
  try {
    arq = backup.caminho(req.params.nome);
    if (!fs.existsSync(arq)) return res.status(404).json({ error: "Backup não encontrado." });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  await executarRestauracao(arq, res);
});

// Upload de restauração: só arquivos SQLite válidos, tamanho limitado, e o
// magic bytes são conferidos antes de qualquer coisa ser gravada no disco.
app.post(
  "/api/admin/restaurar-upload",
  express.raw({ type: "*/*", limit: "100mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0)
      return res.status(400).json({ error: "Nenhum arquivo recebido." });
    const cab = req.body.subarray(0, 16).toString("latin1");
    if (cab !== "SQLite format 3\0")
      return res.status(400).json({ error: "Este arquivo não é um banco SQLite." });
    if (emRestauracao)
      return res.status(409).json({ error: "Já existe uma restauração em andamento." });
    const tmp = path.join(backup.dir, `upload_${Date.now()}.tmp`);
    fs.writeFileSync(tmp, req.body);
    try {
      await executarRestauracao(tmp, res);
    } finally {
      fs.existsSync(tmp) && fs.unlinkSync(tmp);
    }
  },
);

// rotas inexistentes em /api respondem JSON
app.use("/api", (req, res) => res.status(404).json({ error: "Rota não encontrada." }));

// erro inesperado em qualquer rota vira resposta JSON, não um HTML feio
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  if (res.headersSent) return next(err);
  if (err && err.type === "entity.too.large")
    return res.status(413).json({ error: "Arquivo maior que o permitido." });
  res.status(500).json({ error: "Erro inesperado no servidor." });
});

// exceções em callbacks do banco não derrubam o processo
process.on("uncaughtException", (err) =>
  console.error("Exceção não tratada:", err),
);
process.on("unhandledRejection", (reason) =>
  console.error("Promessa rejeitada sem tratamento:", reason),
);

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
