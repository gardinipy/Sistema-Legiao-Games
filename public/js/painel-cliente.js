async function carregarDadosCliente() {
  try {
    const [dados, historico] = await Promise.all([
      authFetchJson("/api/client/dados"),
      authFetchJson("/api/client/historico"),
    ]);

    document.getElementById("clienteNomeParainel").textContent = dados.name || "Cliente";
    renderizarSaldoCliente(dados);
    renderizarHistoricoCliente(historico);
  } catch (e) {
    console.error("Erro ao carregar dados do cliente:", e);
    toast("Erro ao carregar seus dados.", "erro");
  }
}

function renderizarSaldoCliente(dados) {
  document.getElementById("saldoClienteDisplay").textContent = `R$ ${dados.saldo.toFixed(2)}`;

  const hoje = new Date();
  const validos = dados.credits.filter(
    (cr) => cr.amount >= 1 && new Date(cr.expiresAt) > hoje,
  );

  if (validos.length === 0) {
    document.getElementById("creditosClienteDisplay").textContent = "Nenhum crédito ativo.";
    return;
  }

  const html = validos
    .map((cr) => {
      const dataExp = new Date(cr.expiresAt).toLocaleDateString("pt-BR");
      return `<div style="font-size: 11px; color: #aaa; margin-top: 4px;">• R$ ${cr.amount.toFixed(2)} — Vence ${dataExp}</div>`;
    })
    .join("");

  document.getElementById("creditosClienteDisplay").innerHTML = html;
}

function renderizarHistoricoCliente(historico) {
  const div = document.getElementById("historicoClienteDisplay");

  if (historico.length === 0) {
    div.innerHTML = `<p style="text-align:center; color:#aaa; font-size:13px;">Nenhuma compra ainda.</p>`;
    return;
  }

  div.innerHTML = historico
    .map((comanda) => {
      const dataFormatada = new Date(comanda.data).toLocaleDateString("pt-BR");
      const horaFormatada = new Date(comanda.data).toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const itensHtml = comanda.items
        .map((i) => {
          const subtotal = (i.price || 0) * (i.quantity || 1);
          return `
            <div style="font-size: 12px; color: #e9d5ff; margin-left: 10px; margin-top: 4px; display: flex; justify-content: space-between;">
              <span>- ${escHtml(i.name)} (x${i.quantity || 1})</span>
              <span>R$ ${subtotal.toFixed(2)}</span>
            </div>`;
        })
        .join("");

      const obsHtml = comanda.observacao
        ? `<div style="font-size: 11px; color: #c084fc; margin-top: 6px; font-style: italic;">📝 ${escHtml(comanda.observacao)}</div>`
        : "";

      return `
        <div class="list-item" style="align-items: flex-start; margin-bottom: 10px;">
          <div style="width: 100%; display: flex; justify-content: space-between; margin-bottom: 6px;">
            <span style="font-size: 12px; color: #aaa;">${dataFormatada} às ${horaFormatada}</span>
          </div>
          <div style="width: 100%;">${itensHtml}</div>
          ${obsHtml}
          <div style="width: 100%; text-align: right; margin-top: 8px; border-top: 1px dashed rgba(192, 132, 252, 0.2); padding-top: 8px;">
            <strong style="color: #10b981; font-size: 14px;">Total: R$ ${comanda.totalGeral.toFixed(2)}</strong>
          </div>
        </div>`;
    })
    .join("");
}
