// backup/restauração do db; cada backup é um db único que
// já embute as comandas abertas (tabela _extras), então um arquivo basta
// pra recuperar tudo. Backups com mais de 30 dias são apagados sozinhos.

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

// Helpers: transformam a API de callbacks do sqlite3 em Promises
const dbRun = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) {
      err ? reject(err) : resolve(this);
    }),
  );
const dbAll = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
const dbGet = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))),
  );

// Backups mais antigos que isso (em dias) são apagados
const DIAS_PARA_APAGAR = 30;

// Data/hora LOCAL no formato 2026-10-10_17-30-00
function dataHoraLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

function criarModuloBackup({
  db,
  dataFile,
  dir = path.join(__dirname, "backups"),
}) {
  fs.mkdirSync(dir, { recursive: true });

  // Impede nomes como ../../etc/passwd
  function caminho(nome) {
    const base = path.basename(String(nome));
    if (!/^[\w.-]+\.sqlite$/.test(base))
      throw new Error("Nome de arquivo inválido.");
    return path.join(dir, base);
  }

  // O parâmetro é mantido só por compatibilidade com quem chama criar("auto"),
  // criar("manual") etc. O nome do arquivo é sempre backup_data_hora.
  async function criar() {
    const nome = `backup_${dataHoraLocal()}.sqlite`;
    const destino = path.join(dir, nome);

    // Já existe um backup deste mesmo segundo: ele serve, não precisa de outro
    if (fs.existsSync(destino)) return nome;

    // VACUUM INTO gera uma cópia consistente mesmo com o sistema em uso
    await dbRun(db, "VACUUM INTO ?", [destino]);

    // Guarda também as comandas abertas (que ficam num .json fora do banco)
    const copia = new sqlite3.Database(destino);
    try {
      await dbRun(
        copia,
        "CREATE TABLE IF NOT EXISTS _extras (chave TEXT PRIMARY KEY, valor TEXT)",
      );
      const json = fs.existsSync(dataFile)
        ? fs.readFileSync(dataFile, "utf8")
        : "{}";
      await dbRun(
        copia,
        "INSERT OR REPLACE INTO _extras (chave, valor) VALUES ('comandas_abertas', ?)",
        [json],
      );
    } finally {
      await new Promise((resolve) => copia.close(resolve));
    }

    limparAntigos();
    syncExterno();
    return nome;
  }

  // resultado da última tentativa de envio externo
  let statusExterno = { remoto: null, ok: null, ultimaTentativa: null, erro: null };

  // RCLONE_REMOTE no .env (ex.: "gdrive:legiao-backups") ativa o envio;
  // configure o remote com "rclone config"
  function syncExterno() {
    const remoto = process.env.RCLONE_REMOTE;
    if (!remoto) return;
    statusExterno = {
      remoto,
      ok: null,
      ultimaTentativa: new Date().toISOString(),
      erro: null,
    };
    const { execFile } = require("child_process");
    execFile(
      "rclone",
      ["copy", dir, remoto, "--transfers", "2", "--quiet"],
      (err) => {
        if (err) {
          statusExterno.ok = false;
          statusExterno.erro = err.message;
          console.error("Falha ao sincronizar backups com rclone:", err.message);
        } else {
          statusExterno.ok = true;
          console.log("Backups enviados para", remoto);
        }
      },
    );
  }

  function statusExternoAtual() {
    return {
      ...statusExterno,
      remoto: process.env.RCLONE_REMOTE || null,
      emConfig: !process.env.RCLONE_REMOTE,
    };
  }

  function listar() {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          nome: f,
          tipo: "backup",
          tamanho: st.size,
          data: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.data.localeCompare(a.data));
  }

  // Apaga backups com mais de 30 dias. O backup mais recente nunca é apagado,
  // mesmo que seja antigo (evita ficar sem nenhum se o sistema ficou parado).
  function limparAntigos() {
    const limite = Date.now() - DIAS_PARA_APAGAR * 24 * 60 * 60 * 1000;
    listar()
      .slice(1)
      .filter((b) => new Date(b.data).getTime() < limite)
      .forEach((b) => {
        try {
          fs.unlinkSync(path.join(dir, b.nome));
          console.log(`Backup antigo apagado: ${b.nome}`);
        } catch (e) {
          console.error(`Não foi possível apagar ${b.nome}:`, e.message);
        }
      });
  }

  // Também limpa ao iniciar o sistema
  limparAntigos();

  // Substitui os dados atuais pelos de um arquivo de backup.
  // Funciona com o servidor ligado, sem precisar reiniciar.
  async function restaurar(arquivo) {
    // 1. Confere se é mesmo um arquivo SQLite
    const cab = Buffer.alloc(16);
    const fd = fs.openSync(arquivo, "r");
    fs.readSync(fd, cab, 0, 16, 0);
    fs.closeSync(fd);
    if (cab.toString("utf8", 0, 15) !== "SQLite format 3")
      throw new Error("Este arquivo não é um banco SQLite.");

    // 2. Rede de segurança: guarda o estado atual antes de substituir
    await criar();

    let comandasAbertas = null;
    await dbRun(db, "ATTACH DATABASE ? AS bkp", [arquivo]);
    try {
      const chk = await dbAll(db, "PRAGMA bkp.integrity_check");
      if (!(chk.length === 1 && chk[0].integrity_check === "ok"))
        throw new Error("O arquivo de backup está corrompido.");

      const nomes = async (schema) =>
        (
          await dbAll(
            db,
            `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
          )
        ).map((t) => t.name);
      const tabMain = await nomes("main");
      const tabBkp = await nomes("bkp");
      const comuns = tabMain.filter(
        (t) => t !== "_extras" && tabBkp.includes(t),
      );
      if (!comuns.length)
        throw new Error(
          "Este arquivo não parece ser um backup do Legião Games.",
        );

      if (tabBkp.includes("_extras")) {
        const r = await dbGet(
          db,
          "SELECT valor FROM bkp._extras WHERE chave = 'comandas_abertas'",
        );
        if (r) comandasAbertas = r.valor;
      }

      // 3. Troca os dados dentro de uma transação: ou restaura tudo, ou nada
      await dbRun(db, "BEGIN IMMEDIATE");
      try {
        for (const t of comuns) {
          const colsMain = (
            await dbAll(db, `PRAGMA main.table_info("${t}")`)
          ).map((c) => c.name);
          const colsBkp = (
            await dbAll(db, `PRAGMA bkp.table_info("${t}")`)
          ).map((c) => c.name);
          const cols = colsMain
            .filter((c) => colsBkp.includes(c))
            .map((c) => `"${c}"`)
            .join(", ");
          await dbRun(db, `DELETE FROM main."${t}"`);
          await dbRun(
            db,
            `INSERT INTO main."${t}" (${cols}) SELECT ${cols} FROM bkp."${t}"`,
          );
        }
        await dbRun(db, "COMMIT");
      } catch (e) {
        await dbRun(db, "ROLLBACK");
        throw e;
      }
    } finally {
      await dbRun(db, "DETACH DATABASE bkp");
    }

    // 4. Restaura as comandas abertas (se o backup tiver) — e confere que o
    // conteúdo é mesmo o JSON esperado antes de gravar em cima do arquivo vivo
    if (comandasAbertas !== null) {
      try {
        const v = JSON.parse(comandasAbertas);
        if (!v || typeof v !== "object" || Array.isArray(v)) return;
      } catch (e) {
        return;
      }
      fs.writeFileSync(dataFile, comandasAbertas);
    }
  }

  return { criar, listar, restaurar, limparAntigos, caminho, dir, statusExterno: statusExternoAtual };
}

module.exports = { criarModuloBackup };