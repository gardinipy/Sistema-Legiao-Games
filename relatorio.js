// Relatório .xlsx gerado dentro do Node (exceljs) — sem executar Python
// nem comandos externos. Download feito pelo painel administrativo.

const ExcelJS = require("exceljs");

const dbAll = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

function parseJsonSeguro(texto, padrao = []) {
  try {
    const v = JSON.parse(texto ?? "null");
    return v === null || v === undefined ? padrao : v;
  } catch (e) {
    return padrao;
  }
}

function fmtMoeda(n) {
  return Number(n.toFixed(2));
}

function linhaItens(items) {
  return (items || [])
    .map(
      (i) =>
        `${i.quantity || 1}x ${i.name} (${i.paymentMethod || "sem forma"}) — R$ ${(
          (i.price || 0) * (i.quantity || 1)
        ).toFixed(2)}`,
    )
    .join("; ");
}

async function gerarRelatorioBuffer(db) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Legião Games";
  wb.created = new Date();

  // ---------- Histórico Geral ----------
  const comandas = await dbAll(db,
    `SELECT c.id, c.clientId, c.items, c.totalGeral, c.observacao, c.data, cl.name AS clienteNome
       FROM comandas c LEFT JOIN clients cl ON cl.id = c.clientId
       ORDER BY c.data DESC`,
  );
  const wsHist = wb.addWorksheet("Histórico Geral");
  wsHist.columns = [
    { header: "Venda #", key: "id", width: 10 },
    { header: "Cliente", key: "cliente", width: 28 },
    { header: "Data", key: "data", width: 22 },
    { header: "Itens", key: "itens", width: 60 },
    { header: "Observação", key: "obs", width: 40 },
    { header: "Total (R$)", key: "total", width: 14 },
  ];
  for (const c of comandas) {
    wsHist.addRow({
      id: c.id,
      cliente: c.clienteNome || "Cliente Deletado",
      data: new Date(c.data).toLocaleString("pt-BR"),
      itens: linhaItens(parseJsonSeguro(c.items)),
      obs: c.observacao || "",
      total: fmtMoeda(c.totalGeral),
    });
  }
  wsHist.getRow(1).font = { bold: true };

  // ---------- Lucro Diário ----------
  const diarioMap = new Map();
  for (const c of comandas) {
    const dia = String(c.data).slice(0, 10);
    diarioMap.set(dia, (diarioMap.get(dia) || 0) + c.totalGeral);
  }
  const wsDiario = wb.addWorksheet("Lucro Diário");
  wsDiario.columns = [
    { header: "Dia", key: "dia", width: 14 },
    { header: "Total vendido (R$)", key: "total", width: 20 },
  ];
  [...diarioMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .forEach(([dia, total]) => wsDiario.addRow({ dia, total: fmtMoeda(total) }));
  wsDiario.getRow(1).font = { bold: true };

  // ---------- Itens Consumidos ----------
  const itensMap = new Map();
  for (const c of comandas) {
    for (const i of parseJsonSeguro(c.items)) {
      const chave = `${i.name} @${Number(i.price).toFixed(2)}`;
      const atual = itensMap.get(chave) || { name: i.name, price: i.price, qtd: 0, sub: 0 };
      atual.qtd += i.quantity || 1;
      atual.sub += (i.price || 0) * (i.quantity || 1);
      itensMap.set(chave, atual);
    }
  }
  const wsItens = wb.addWorksheet("Itens Consumidos");
  wsItens.columns = [
    { header: "Item", key: "item", width: 30 },
    { header: "Preço unit. (R$)", key: "preco", width: 16 },
    { header: "Quantidade", key: "qtd", width: 12 },
    { header: "Subtotal (R$)", key: "sub", width: 14 },
  ];
  [...itensMap.values()]
    .sort((a, b) => b.sub - a.sub)
    .forEach((i) =>
      wsItens.addRow({ item: i.name, preco: fmtMoeda(i.price), qtd: i.qtd, sub: fmtMoeda(i.sub) }),
    );
  wsItens.getRow(1).font = { bold: true };

  // ---------- Clientes com Crédito ----------
  const clientes = await dbAll(db, `SELECT name, credits FROM clients ORDER BY name`);
  const hoje = new Date();
  const wsCred = wb.addWorksheet("Clientes com Crédito");
  wsCred.columns = [
    { header: "Cliente", key: "cliente", width: 28 },
    { header: "Saldo válido (R$)", key: "saldo", width: 18 },
  ];
  for (const c of clientes) {
    const credits = parseJsonSeguro(c.credits, []);
    const saldo = credits
      .filter((cr) => cr.amount >= 1 && new Date(cr.expiresAt) > hoje)
      .reduce((s, cr) => s + cr.amount, 0);
    wsCred.addRow({ cliente: c.name, saldo: fmtMoeda(saldo) });
  }
  wsCred.getRow(1).font = { bold: true };

  // ---------- Não Pagos (Fiados) ----------
  const fiados = await dbAll(db,
    `SELECT f.*, cl.name AS clienteNome
       FROM fiados f LEFT JOIN clients cl ON cl.id = f.clientId
      WHERE f.status = 'Pendente' ORDER BY f.data DESC`,
  );
  const wsFiado = wb.addWorksheet("Não Pagos (Fiados)");
  wsFiado.columns = [
    { header: "Cliente", key: "cliente", width: 28 },
    { header: "Data", key: "data", width: 22 },
    { header: "Item", key: "item", width: 30 },
    { header: "Qtd", key: "qtd", width: 8 },
    { header: "Subtotal (R$)", key: "sub", width: 14 },
  ];
  for (const f of fiados) {
    wsFiado.addRow({
      cliente: f.clienteNome || "Cliente Deletado",
      data: new Date(f.data).toLocaleString("pt-BR"),
      item: f.name,
      qtd: f.quantity,
      sub: fmtMoeda(f.price * f.quantity),
    });
  }
  wsFiado.getRow(1).font = { bold: true };

  // larguras nunca abaixo de um mínimo legível
  [wsHist, wsDiario, wsItens, wsCred, wsFiado].forEach((ws) =>
    ws.columns.forEach((col) => (col && (col.width = Math.max(col.width || 10, 12)))),
  );

  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}

module.exports = { gerarRelatorioBuffer };
