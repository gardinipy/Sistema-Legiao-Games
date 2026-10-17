let produtos = [];
let clientes = [];
let comandasHistorico = [];
let comandasAbertas = {};
let fiadosPendentes = [];
let dadosCarregados = false;

// Sem handler inline no HTML: as abas marcadas com data-tab
function showTab(tabName) {
  document.querySelectorAll(".tab-content").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".tabs button").forEach((el) => el.classList.remove("active"));
  document.getElementById(tabName).classList.add("active");

  document.querySelectorAll(".tabs button").forEach((btn) => {
    if (btn.dataset.tab === tabName) btn.classList.add("active");
  });

  if (tabName === "historico") carregarHistorico();
  else if (tabName === "clientes") renderClientes();
  else if (tabName === "produtos") renderProdutos();
  else if (tabName === "comandasAbertasTab") renderComandasAbertasCards();
  else if (tabName === "naoPagas") renderNaoPagas();
  else if (tabName === "adminTab") backupCarregar();
}

async function carregarDadosGerais() {
  if (dadosCarregados) return;
  const tsHoje = document.getElementById("dataHojeTexto");
  if (tsHoje) tsHoje.innerText = new Date().toLocaleDateString("pt-BR");

  try {
    const [prod, cli, dataAb, fiados] = await Promise.all([
      authFetchJson("/api/products"),
      authFetchJson("/api/clients"),
      authFetchJson("/api/comandas-abertas"),
      authFetchJson("/api/fiados"),
    ]);

    produtos = prod;
    clientes = cli;
    fiadosPendentes = fiados;
    historicoCarregado = false; // força recarregar o histórico na próxima vez

    comandasAbertas = {};
    Object.keys(dataAb).forEach((clientId) => {
      const val = dataAb[clientId];
      if (Array.isArray(val)) {
        comandasAbertas[clientId] = { items: val, observacao: "" };
      } else if (val && typeof val === "object") {
        comandasAbertas[clientId] = {
          items: val.items || [],
          observacao: val.observacao || "",
        };
      }
    });

    Object.keys(comandasAbertas).forEach((clientId) => {
      comandasAbertas[clientId].items.forEach((item) => {
        if (!item.quantity) item.quantity = 1;
        if (!item.paymentMethod) item.paymentMethod = "";
      });
    });

    dadosCarregados = true;
    renderProdutos();
    renderClientes();
    renderComandasAbertasCards();
    renderNaoPagas();
    atualizarSelectCriarComanda();
  } catch (e) {
    console.error("Erro ao carregar dados:", e);
  }
}

async function recarregarTudo() {
  dadosCarregados = false;
  await carregarDadosGerais();
}

// grava apenas a comanda aberta deste cliente; estado=null fecha ela
// no arquivo sem mexer nas comandas dos outros operadores
async function salvarComandasAbertasNoServidor(clientId) {
  try {
    const r = await authFetch("/api/comandas-abertas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        __modo: "merge",
        clientId: String(clientId),
        estado: comandasAbertas[clientId] !== undefined ? comandasAbertas[clientId] : null,
      }),
      keepalive: true,
    });
    if (!r.ok) throw new Error("status " + r.status);
  } catch (e) {
    console.error("Falha ao salvar comandas:", e);
    toast("Não foi possível salvar no servidor. Verifique a conexão.", "erro");
  }
}

// iOS: ao trocar de app ou bloquear a tela, envia na hora o que estiver pendente
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && timerObservacao) {
    clearTimeout(timerObservacao);
    timerObservacao = null;
    salvarComandasAbertasNoServidor(timerObservacaoClienteId);
  }
});

async function baixarRelatorioExcel() {
  toast("Gerando relatório...", "info");
  try {
    const r = await authFetch("/api/relatorio/excel");
    if (!r.ok) {
      let msg = "Erro ao gerar o relatório.";
      try { msg = (await r.json()).error || msg; } catch (e) {}
      return toast(msg, "erro");
    }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Relatorio_Completo_Legiao_Games.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast("Erro de conexão ao gerar o relatório.", "erro");
  }
}

function formatarData(dataISO) {
  return new Date(dataISO).toLocaleDateString("pt-BR", { timeZone: "UTC" });
}
function formatarDataHora(dataISO) {
  return new Date(dataISO).toLocaleString("pt-BR");
}

function clientesParaCriar(mostrarTodos) {
  const termo = mostrarTodos
    ? ""
    : document.getElementById("searchClienteCriar").value.toLowerCase().trim();
  return clientes
    .filter(
      (c) =>
        (!comandasAbertas[c.id] || comandasAbertas[c.id].items.length === 0) &&
        c.name.toLowerCase().includes(termo),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

function abrirListaClienteCriar() {
  const lista = document.getElementById("listaClienteCriar");
  const jaEscolhido = !!document.getElementById("selectClienteCriar").value;
  const filtrados = clientesParaCriar(jaEscolhido);
  lista.innerHTML =
    filtrados.length === 0
      ? `<div class="combo-item" style="color:#aaa; cursor:default;">Nenhum cliente encontrado</div>`
      : filtrados
          .map(
            (c) =>
              `<div class="combo-item" data-act="selecionarClienteCriar" data-valor="${escHtml(c.id)}">${escHtml(c.name)} <small>(Saldo: R$ ${calcularCreditosValidos(c.credits).toFixed(2)})</small></div>`,
          )
          .join("");
  lista.style.display = "block";
}

function digitarClienteCriar() {
  document.getElementById("selectClienteCriar").value = "";
  abrirListaClienteCriar();
}

function selecionarClienteCriar(id) {
  const c = clientes.find((cli) => cli.id == id);
  if (!c) return;
  document.getElementById("selectClienteCriar").value = c.id;
  document.getElementById("searchClienteCriar").value = c.name;
  document.getElementById("listaClienteCriar").style.display = "none";
}

function enterClienteCriar() {
  const filtrados = clientesParaCriar(false);
  if (filtrados.length >= 1) selecionarClienteCriar(filtrados[0].id);
}

function limparClienteCriar() {
  document.getElementById("selectClienteCriar").value = "";
  document.getElementById("searchClienteCriar").value = "";
  document.getElementById("listaClienteCriar").style.display = "none";
}

function produtosParaCriar(mostrarTodos) {
  const termo = mostrarTodos
    ? ""
    : document.getElementById("searchProdutoCriar").value.toLowerCase().trim();
  return produtos
    .filter((p) => p.name.toLowerCase().includes(termo))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

function abrirListaProdutoCriar() {
  const lista = document.getElementById("listaProdutoCriar");
  const jaEscolhido = !!document.getElementById("selectProdutoCriar").value;
  const filtrados = produtosParaCriar(jaEscolhido);
  lista.innerHTML =
    filtrados.length === 0
      ? `<div class="combo-item" style="color:#aaa; cursor:default;">Nenhum produto encontrado</div>`
      : filtrados
          .map(
            (p) =>
              `<div class="combo-item" data-act="selecionarProdutoCriar" data-valor="${escHtml(p.id)}">${escHtml(p.name)} <small>(R$ ${Number(p.price).toFixed(2)})</small></div>`,
          )
          .join("");
  lista.style.display = "block";
}

function digitarProdutoCriar() {
  document.getElementById("selectProdutoCriar").value = "";
  abrirListaProdutoCriar();
}

function selecionarProdutoCriar(id) {
  const p = produtos.find((prod) => prod.id == id);
  if (!p) return;
  document.getElementById("selectProdutoCriar").value = p.id;
  document.getElementById("searchProdutoCriar").value = p.name;
  document.getElementById("listaProdutoCriar").style.display = "none";
}

function enterProdutoCriar() {
  const filtrados = produtosParaCriar(false);
  if (filtrados.length >= 1) selecionarProdutoCriar(filtrados[0].id);
}

function limparProdutoCriar() {
  document.getElementById("selectProdutoCriar").value = "";
  document.getElementById("searchProdutoCriar").value = "";
  document.getElementById("listaProdutoCriar").style.display = "none";
}

// fecha as listas ao tocar fora do campo
document.addEventListener("click", (e) => {
  ["listaClienteCriar", "listaProdutoCriar"].forEach((id) => {
    const lista = document.getElementById(id);
    if (lista && !lista.parentElement.contains(e.target)) lista.style.display = "none";
  });
});

function atualizarSelectCriarComanda() {
  const hid = document.getElementById("selectClienteCriar");
  if (hid.value && comandasAbertas[hid.value] && comandasAbertas[hid.value].items.length > 0) {
    hid.value = "";
    document.getElementById("searchClienteCriar").value = "";
  }
  document.getElementById("listaClienteCriar").style.display = "none";

  const hidProd = document.getElementById("selectProdutoCriar");
  if (hidProd.value && !produtos.some((p) => p.id == hidProd.value)) limparProdutoCriar();
  document.getElementById("listaProdutoCriar").style.display = "none";
}

function abrirNovaComanda() {
  const clienteId = document.getElementById("selectClienteCriar").value;
  const produtoId = document.getElementById("selectProdutoCriar").value;
  if (!clienteId || !produtoId) return toast("Selecione cliente e produto!", "erro");

  if (!comandasAbertas[clienteId]) comandasAbertas[clienteId] = { items: [], observacao: "" };
  const produto = produtos.find((p) => p.id == produtoId);

  const itemExistente = comandasAbertas[clienteId].items.find(
    (i) => (i.productId == produto.id || i.name === produto.name) && i.paymentMethod === "" && i.price === produto.price,
  );
  if (itemExistente) itemExistente.quantity += 1;
  else
    comandasAbertas[clienteId].items.push({
      productId: produto.id,
      name: produto.name,
      price: produto.price,
      quantity: 1,
      paymentMethod: "",
    });

  salvarComandasAbertasNoServidor(clienteId);
  showTab("comandasAbertasTab");
  renderComandasAbertasCards();

  limparClienteCriar();
  limparProdutoCriar();
  atualizarSelectCriarComanda();

  setTimeout(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, 50);
}

function adicionarMaisNoCard(clientId) {
  const prodId = document.getElementById(`prod-add-${clientId}`).value;
  if (!prodId) return toast("Selecione um produto!", "erro");
  const p = produtos.find((p) => p.id == prodId);
  const exist = comandasAbertas[clientId].items.find(
    (i) => i.productId == p.id && i.paymentMethod === "" && i.price === p.price,
  );
  if (exist) exist.quantity += 1;
  else
    comandasAbertas[clientId].items.push({
      productId: p.id,
      name: p.name,
      price: p.price,
      quantity: 1,
      paymentMethod: "",
    });

  salvarComandasAbertasNoServidor(clientId);
  renderComandasAbertasCards();

  setTimeout(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, 50);
}

function renderComandasAbertasCards() {
  const div = document.getElementById("listaComandasAbertasCards");
  const termo = document.getElementById("searchComandasAbertas").value.toLowerCase();
  const idsClientes = Object.keys(comandasAbertas)
    .filter((id) => {
      if (!comandasAbertas[id] || !comandasAbertas[id].items || comandasAbertas[id].items.length === 0)
        return false;
      const cliente = clientes.find((c) => c.id == id);
      return cliente ? cliente.name.toLowerCase().includes(termo) : false;
    })
    .sort((idA, idB) => {
      const nomeA = clientes.find((c) => c.id == idA)?.name || "";
      const nomeB = clientes.find((c) => c.id == idB)?.name || "";
      return nomeA.localeCompare(nomeB, "pt-BR", { sensitivity: "base" });
    });

  if (idsClientes.length === 0) {
    div.innerHTML = `<p style="text-align:center; color:#aaa; margin-top: 20px;">Nenhuma comanda aberta encontrada.</p>`;
    return;
  }

  const opcoesProdutos = produtos
    .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)} - R$ ${Number(p.price).toFixed(2)}</option>`)
    .join("");

  div.innerHTML = idsClientes
    .map((clientId) => {
      const cliente = clientes.find((c) => c.id == clientId);
      const nomeCliente = cliente ? cliente.name : "Cliente Desconhecido";
      const comandaData = comandasAbertas[clientId];
      let totGeral = 0;

      const itensHtml = comandaData.items
        .map((item, index) => {
          const subtotal = item.price * item.quantity;
          totGeral += subtotal;
          return `
                      <div style="margin-bottom: 12px; border-bottom: 1px dashed rgba(192, 132, 252, 0.2); padding-bottom: 10px;">
                          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
                              <span style="font-weight:600; font-size:15px; color:#fff;">${escHtml(item.name)}</span>
                              <span data-act="removerItemCard" data-client-id="${escHtml(clientId)}" data-index="${index}" style="color:#e11d48; font-weight:bold; cursor:pointer; font-size:20px; padding: 0 5px;">&times;</span>
                          </div>
                          <div style="display:flex; justify-content:space-between; align-items:center; gap: 10px;">
                              <div style="display: flex; align-items: center; gap: 6px;">
                                  <button data-act="alterarQtd" data-client-id="${escHtml(clientId)}" data-index="${index}" data-delta="-1" style="background:rgba(255,255,255,0.2); border:none; color:#fff; width:34px; height:34px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:18px; display:flex; align-items:center; justify-content:center; margin:0; padding:0;">-</button>
                                  <span style="font-size:16px; font-weight:bold; color:#e9d5ff; min-width: 20px; text-align: center;">${item.quantity}</span>
                                  <button data-act="alterarQtd" data-client-id="${escHtml(clientId)}" data-index="${index}" data-delta="1" style="background:rgba(255,255,255,0.2); border:none; color:#fff; width:34px; height:34px; border-radius:6px; cursor:pointer; font-weight:bold; font-size:18px; display:flex; align-items:center; justify-content:center; margin:0; padding:0;">+</button>
                              </div>
                              <div style="text-align:right;">
                                  <span style="font-size:11px; color:#aaa;">R$ ${item.price.toFixed(2)} un</span>
                                  <button data-act="editarValorItem" data-client-id="${escHtml(clientId)}" data-index="${index}" style="background:none; border:none; cursor:pointer; padding:0;">✏️</button><br>
                                  <strong style="font-size:14px; color:#10b981;">R$ ${subtotal.toFixed(2)}</strong>
                              </div>
                          </div>
                          <div style="margin-top: 6px;">
                              <select id="pagto-${escHtml(clientId)}-${index}" data-act="mudarPagamentoCard" data-client-id="${escHtml(clientId)}" data-index="${index}" style="width: 100%; padding: 8px; font-size: 16px !important; border-radius: 5px; ${item.paymentMethod === "" ? "border: 2px solid #e11d48;" : ""}">
                                  <option value="">Pendente (Forma)...</option>
                                  <option value="Dinheiro" ${item.paymentMethod === "Dinheiro" ? "selected" : ""}>Dinheiro</option>
                                  <option value="PIX" ${item.paymentMethod === "PIX" ? "selected" : ""}>PIX</option>
                                  <option value="Cartao de Credito" ${item.paymentMethod === "Cartao de Credito" ? "selected" : ""}>Cartão (Crédito)</option>
                                  <option value="Cartao de Debito" ${item.paymentMethod === "Cartao de Debito" ? "selected" : ""}>Cartão (Débito)</option>
                                  <option value="Credito" ${item.paymentMethod === "Credito" ? "selected" : ""}>Crédito Legião</option>
                                  <option value="Fiado" ${item.paymentMethod === "Fiado" ? "selected" : ""}>Fiado (Não Pago)</option>
                              </select>
                          </div>
                      </div>`;
        })
        .join("");

      return `
                  <div class="list-item" style="align-items:flex-start; margin-bottom: 15px;">
                      <div style="width: 100%; display: flex; justify-content: space-between; align-items:center; margin-bottom: 8px;">
                          <strong style="color: #c084fc; font-size: 17px;">${escHtml(nomeCliente)}</strong>
                          <button class="btn-del" style="padding:4px 8px; font-size:11px; margin:0;" data-act="apagarComandaInteira" data-client-id="${escHtml(clientId)}">Excluir Comanda</button>
                      </div>
                      <div style="width: 100%; margin-top: 5px;">${itensHtml}</div>
                      <div style="width: 100%; margin-top: 8px;">
                          <label style="font-size: 12px; color: #c084fc;">Observações:</label>
                          <input type="text" value="${escHtml(comandaData.observacao)}" data-act="atualizarObservacao" data-client-id="${escHtml(clientId)}" style="padding:8px; font-size:16px !important;">
                      </div>
                      <div style="width: 100%; display:flex; gap:5px; margin-top:10px;">
                          <select id="prod-add-${escHtml(clientId)}" style="padding:8px; font-size:16px !important; width:70%;"><option value="">Adicionar produto...</option>${opcoesProdutos}</select>
                          <button class="btn-add" style="margin:0; width:30%; padding:8px; font-size:14px;" data-act="adicionarMaisNoCard" data-client-id="${escHtml(clientId)}">+ Adicionar</button>
                      </div>
                      <div style="margin-top: 12px; width: 100%; display:flex; justify-content:space-between; align-items:center; border-top: 1px solid rgba(192, 132, 252, 0.3); padding-top: 10px;">
                          <strong style="color:#fff; font-size: 15px;">Total: R$ ${totGeral.toFixed(2)}</strong>
                          <button class="btn-success" style="margin:0; width:auto; padding:8px 15px; font-size:13px;" data-act="finalizarComandaCard" data-client-id="${escHtml(clientId)}">Finalizar Comanda</button>
                      </div>
                  </div>`;
    })
    .join("");
}

let timerObservacao = null;
let timerObservacaoClienteId = null;
function atualizarObservacao(clientId, valor) {
  if (!comandasAbertas[clientId]) return;
  comandasAbertas[clientId].observacao = valor;
  timerObservacaoClienteId = clientId;
  clearTimeout(timerObservacao);
  timerObservacao = setTimeout(() => salvarComandasAbertasNoServidor(timerObservacaoClienteId), 600);
}
function alterarQtd(clientId, index, delta) {
  comandasAbertas[clientId].items[index].quantity += Number(delta);
  if (comandasAbertas[clientId].items[index].quantity <= 0) comandasAbertas[clientId].items.splice(index, 1);
  if (comandasAbertas[clientId].items.length === 0) delete comandasAbertas[clientId];
  salvarComandasAbertasNoServidor(clientId);
  renderComandasAbertasCards();
}
function editarValorItem(clientId, index) {
  const item = comandasAbertas[clientId].items[index];
  const novoValor = prompt(`Alterar valor (R$ ${item.price}):`, item.price);
  if (novoValor !== null && !isNaN(novoValor) && novoValor.trim() !== "") {
    item.price = parseFloat(novoValor);
    salvarComandasAbertasNoServidor(clientId);
    renderComandasAbertasCards();
  }
}
function mudarPagamentoCard(clientId, index, pagto) {
  const item = comandasAbertas[clientId].items[index];
  if (pagto === "Credito") {
    const cliente = clientes.find((c) => c.id == clientId);
    const saldoTotal = calcularCreditosValidos(cliente.credits);
    let emUso = 0;
    comandasAbertas[clientId].items.forEach((it, i) => {
      if (i !== index && it.paymentMethod === "Credito") emUso += it.price * it.quantity;
    });
    if (emUso + item.price * item.quantity > saldoTotal) {
      toast(`Créditos insuficientes! Saldo: R$ ${saldoTotal.toFixed(2)}`, "erro");
      document.getElementById(`pagto-${clientId}-${index}`).value = item.paymentMethod;
      return;
    }
  }
  item.paymentMethod = pagto;
  salvarComandasAbertasNoServidor(clientId);
  renderComandasAbertasCards();
}
function removerItemCard(clientId, index) {
  comandasAbertas[clientId].items.splice(index, 1);
  if (comandasAbertas[clientId].items.length === 0) delete comandasAbertas[clientId];
  salvarComandasAbertasNoServidor(clientId);
  renderComandasAbertasCards();
  atualizarSelectCriarComanda();
}
function apagarComandaInteira(clientId) {
  if (confirm("Deseja cancelar esta comanda?")) {
    delete comandasAbertas[clientId];
    salvarComandasAbertasNoServidor(clientId);
    renderComandasAbertasCards();
    atualizarSelectCriarComanda();
  }
}
async function finalizarComandaCard(clientId) {
  const comanda = comandasAbertas[clientId];
  if (comanda.items.some((i) => i.paymentMethod === "")) return toast("Selecione o pagamento de todos os produtos!", "erro");
  try {
    const res = await authFetch("/api/comandas/finalizar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId, items: comanda.items, observacao: comanda.observacao }),
    });
    const data = await res.json();
    if (data.error) toast("Erro: " + data.error, "erro");
    else {
      toast("Comanda fechada! Fiados, se houver, foram para Não Pagas.", "sucesso");
      delete comandasAbertas[clientId];
      recarregarTudo();
    }
  } catch (e) {}
}

async function addProduto() {
  const name = document.getElementById("prodName").value;
  const price = document.getElementById("prodPrice").value;
  if (!name || !price) return;
  await authFetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, price }),
  });
  document.getElementById("prodName").value = "";
  document.getElementById("prodPrice").value = "";
  produtos = await authFetchJson("/api/products");
  renderProdutos();
  atualizarSelectCriarComanda();
}
function abrirModalProduto(id) {
  const p = produtos.find((x) => x.id == id);
  if (!p) return;
  document.getElementById("modalProdId").value = p.id;
  document.getElementById("modalProdName").value = p.name;
  document.getElementById("modalProdPrice").value = p.price;
  document.getElementById("modalProdutoOverlay").style.display = "block";
  document.getElementById("modalProdutoBox").style.display = "block";
}
function fecharModalProduto() {
  document.getElementById("modalProdutoOverlay").style.display = "none";
  document.getElementById("modalProdutoBox").style.display = "none";
}
async function salvarModalProduto() {
  const id = document.getElementById("modalProdId").value;
  const name = document.getElementById("modalProdName").value;
  const price = document.getElementById("modalProdPrice").value;
  if (!name || !price) return;
  await authFetch(`/api/products/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, price }),
  });
  fecharModalProduto();
  produtos = await authFetchJson("/api/products");
  renderProdutos();
  atualizarSelectCriarComanda();
}
async function delProduto(id) {
  if (confirm("Apagar produto?")) {
    await authFetch(`/api/products/${id}`, { method: "DELETE" });
    produtos = await authFetchJson("/api/products");
    renderProdutos();
    atualizarSelectCriarComanda();
  }
}
function renderProdutos() {
  const div = document.getElementById("listaProdutos");
  const termo = document.getElementById("searchProdutos").value.toLowerCase();
  const filtrados = produtos.filter((p) => p.name.toLowerCase().includes(termo));
  div.innerHTML = filtrados
    .map(
      (p) => `
          <div class="list-item" style="flex-direction: row; justify-content: space-between; align-items: center;">
              <div><b>${escHtml(p.name)}</b> - R$ ${Number(p.price).toFixed(2)}</div>
              <div style="display:flex; gap: 5px;">
                  <button data-act="abrirModalProduto" data-valor="${escHtml(p.id)}" style="background:rgba(255,255,255,0.1); border-radius:5px; padding:6px 10px; border:none; cursor:pointer;">✏️</button>
                  <button class="btn-del" style="margin:0; padding:6px 10px;" data-act="delProduto" data-valor="${escHtml(p.id)}">❌</button>
              </div>
          </div>`,
    )
    .join("");
}

async function addCliente() {
  const name = document.getElementById("clientName").value;
  if (!name) return;
  await authFetch("/api/clients", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  document.getElementById("clientName").value = "";
  clientes = await authFetchJson("/api/clients");
  renderClientes();
  atualizarSelectCriarComanda();
}
function calcularCreditosValidos(creditsArray) {
  const hoje = new Date();
  let total = 0;
  creditsArray.forEach((c) => {
    if (new Date(c.expiresAt) > hoje && c.amount >= 1) total += c.amount;
  });
  return total;
}
function abrirModalCredito(clientId, index = -1) {
  document.getElementById("modalClientId").value = clientId;
  document.getElementById("modalCreditIndex").value = index;
  if (index === -1 || index === undefined) {
    document.getElementById("modalCreditoTitulo").innerText = "Novo Crédito";
    document.getElementById("modalCreditoValor").value = "";
    const d = new Date();
    d.setDate(d.getDate() + 30);
    document.getElementById("modalCreditoData").value = d.toISOString().split("T")[0];
  } else {
    document.getElementById("modalCreditoTitulo").innerText = "Editar Crédito";
    const cliente = clientes.find((c) => c.id == clientId);
    const cred = cliente.credits[index];
    document.getElementById("modalCreditoValor").value = cred.amount;
    document.getElementById("modalCreditoData").value = cred.expiresAt.split("T")[0];
  }
  document.getElementById("modalCreditoOverlay").style.display = "block";
  document.getElementById("modalCreditoBox").style.display = "block";
}
function fecharModalCredito() {
  document.getElementById("modalCreditoOverlay").style.display = "none";
  document.getElementById("modalCreditoBox").style.display = "none";
}
async function salvarModalCredito() {
  const id = document.getElementById("modalClientId").value;
  const index = parseInt(document.getElementById("modalCreditIndex").value);
  const val = document.getElementById("modalCreditoValor").value;
  const dataStr = document.getElementById("modalCreditoData").value;
  if (!val || !dataStr) return toast("Preencha o valor e a data!", "erro");
  const dataValidade = new Date(`${dataStr}T23:59:59Z`);
  if (index === -1) {
    await authFetch(`/api/clients/${id}/addCredit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: val, expiresAt: dataValidade.toISOString() }),
    });
  } else {
    const cliente = clientes.find((c) => c.id == id);
    cliente.credits[index].amount = parseFloat(val);
    cliente.credits[index].expiresAt = dataValidade.toISOString();
    await authFetch(`/api/clients/${id}/credits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits: cliente.credits }),
    });
  }
  fecharModalCredito();
  clientes = await authFetchJson("/api/clients");
  renderClientes();
  atualizarSelectCriarComanda();
}
async function apagarCredito(clientId, creditIndex) {
  if (confirm("Apagar crédito?")) {
    const cliente = clientes.find((c) => c.id == clientId);
    cliente.credits.splice(creditIndex, 1);
    await authFetch(`/api/clients/${clientId}/credits`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credits: cliente.credits }),
    });
    clientes = await authFetchJson("/api/clients");
    renderClientes();
    atualizarSelectCriarComanda();
  }
}
async function excluirCliente(id) {
  const c = clientes.find((cli) => cli.id == id);
  if (!c) return;
  if (comandasAbertas[id] && comandasAbertas[id].items.length > 0)
    return toast(`${c.name} tem uma comanda aberta. Finalize ou cancele antes de excluir.`, "erro");
  if (fiadosPendentes.some((f) => f.clientId == id))
    return toast(`${c.name} tem fiado pendente. Quite a dívida antes de excluir.`, "erro");

  const saldo = calcularCreditosValidos(c.credits);
  const aviso = saldo > 0 ? `\n\nAtenção: ele tem R$ ${saldo.toFixed(2)} de crédito, que será perdido.` : "";
  if (!confirm(`Excluir o cliente "${c.name}"?${aviso}\n\nO histórico de vendas dele é mantido, mas aparecerá como "Cliente Deletado".`))
    return;

  try {
    const r = await authFetch(`/api/clients/${id}`, { method: "DELETE" });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).error || ""; } catch (e) {}
      return toast(msg || "Não foi possível excluir o cliente.", "erro");
    }
  } catch (e) {
    return toast("Erro de conexão ao excluir o cliente.", "erro");
  }

  if (document.getElementById("selectClienteCriar").value == id) limparClienteCriar();
  clientes = await authFetchJson("/api/clients");
  renderClientes();
  atualizarSelectCriarComanda();
}

function renderClientes() {
  const div = document.getElementById("listaClientes");
  const termo = document.getElementById("searchClientes").value.toLowerCase();
  const filtrados = clientes
    .filter((c) => c.name.toLowerCase().includes(termo))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
  const hoje = new Date();
  div.innerHTML = filtrados
    .map((c) => {
      const saldo = calcularCreditosValidos(c.credits);
      const creditosValidos = c.credits.filter((cr) => cr.amount >= 1 && new Date(cr.expiresAt) > hoje);

      let htmlValidades =
        creditosValidos.length > 0
          ? creditosValidos
              .map((cr) => {
                const realIdx = c.credits.indexOf(cr);
                return `
                          <div style="font-size: 12px; color:#e9d5ff; margin-top: 5px; display:flex; justify-content:space-between; align-items:center; background: rgba(0,0,0,0.3); padding: 5px 8px; border-radius: 5px;">
                              <span>• R$ ${cr.amount.toFixed(2)} <br> <small>Vence ${formatarData(cr.expiresAt)}</small></span>
                              <div style="display:flex; gap: 5px;">
                                  <button data-act="abrirModalCredito" data-valor="${escHtml(c.id)}" data-index="${realIdx}" style="background:rgba(255,255,255,0.1); border-radius:5px; padding:5px 8px; border:none; cursor:pointer;">✏️</button>
                                  <button data-act="apagarCredito" data-valor="${escHtml(c.id)}" data-index="${realIdx}" style="background:rgba(255,255,255,0.1); border-radius:5px; padding:5px 8px; border:none; cursor:pointer;">❌</button>
                              </div>
                          </div>`;
              })
              .join("")
          : `<div style="font-size: 12px; color:#999; margin-top: 3px;">Nenhum crédito ativo.</div>`;
      return `
          <div class="list-item">
              <div style="display:flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <div><b>${escHtml(c.name)}</b><br><span style="color:#c084fc; font-weight:bold;">Saldo: R$ ${saldo.toFixed(2)}</span></div>
                  <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                      <button class="btn-add" style="width:auto; margin:0; padding:8px 12px; font-size:12px;" data-act="abrirModalCredito" data-valor="${escHtml(c.id)}">+ Crédito</button>
                      <button style="background: #2563eb; color: white; width:auto; margin:0; padding:8px 12px; border-radius:8px; border:none; cursor:pointer; font-weight:600; font-size:12px;" data-act="abrirModalCliente" data-valor="${escHtml(c.id)}">🔑 Acesso${c.temLogin ? " ✓" : ""}</button>
                      <button class="btn-del" style="margin:0; padding:8px 12px; font-size:12px;" data-act="excluirCliente" data-valor="${escHtml(c.id)}" title="Excluir cliente">🗑️</button>
                  </div>
              </div>
              <div style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(192, 132, 252, 0.2); width: 100%;"><strong style="font-size: 12px; color:#fff;">Histórico:</strong>${htmlValidades}</div>
          </div>`;
    })
    .join("");
}

async function abrirModalCliente(clientId) {
  const cliente = clientes.find((c) => c.id == clientId);
  if (!cliente) return;

  document.getElementById("modalClienteId").value = clientId;
  document.getElementById("modalClienteTitulo").textContent = `Acesso — ${cliente.name}`;
  document.getElementById("modalClienteLogin").value = "";
  document.getElementById("modalClienteCodigo").value = "";

  let configurado = false;
  try {
    const dados = await authFetchJson(`/api/admin/clients/${clientId}/login`);
    if (dados.configurado) {
      configurado = true;
      document.getElementById("modalClienteLogin").value = dados.login || "";
      document.getElementById("modalClienteCodigo").value = dados.accessCode || "";
    }
  } catch (e) {
    return toast("Não foi possível carregar o acesso deste cliente.", "erro");
  }

  document.getElementById("btnResetarCodigo").style.display = configurado ? "block" : "none";
  document.getElementById("btnRemoverAcesso").style.display = configurado ? "block" : "none";
  document.getElementById("modalClienteDica").textContent = configurado
    ? "Acesso já configurado. Você pode alterar o login/código ou resetar o código."
    : "Defina o login e o código que o cliente vai usar para entrar.";

  document.getElementById("modalClienteOverlay").style.display = "block";
  document.getElementById("modalClienteBox").style.display = "block";
}

function fecharModalCliente() {
  document.getElementById("modalClienteOverlay").style.display = "none";
  document.getElementById("modalClienteBox").style.display = "none";
}

function gerarCodigoNoModal() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const rnd = new Uint32Array(6);
  crypto.getRandomValues(rnd);
  document.getElementById("modalClienteCodigo").value = Array.from(rnd, (n) => chars[n % chars.length]).join("");
}

async function recarregarClientesDoModal() {
  clientes = await authFetchJson("/api/clients");
  renderClientes();
}

async function salvarModalCliente() {
  const id = document.getElementById("modalClienteId").value;
  const login = document.getElementById("modalClienteLogin").value.trim();
  const accessCode = document.getElementById("modalClienteCodigo").value.trim();
  if (!login || !accessCode) return toast("Preencha o login e o código.", "erro");
  if (!/^[A-Za-z0-9]{4,6}$/.test(accessCode))
    return toast("O código deve ter de 4 a 6 letras ou números.", "erro");

  const r = await authFetch(`/api/admin/clients/${id}/login`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, accessCode }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error || "Não foi possível salvar.", "erro");

  toast("Acesso do cliente salvo!", "sucesso");
  fecharModalCliente();
  recarregarClientesDoModal();
}

async function resetarCodigoDoModal() {
  const id = document.getElementById("modalClienteId").value;
  if (!confirm("Gerar um NOVO código? O código atual deixa de funcionar na hora.")) return;
  const r = await authFetch(`/api/admin/clients/${id}/reset-code`, { method: "POST" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return toast(data.error || "Não foi possível resetar.", "erro");
  document.getElementById("modalClienteCodigo").value = data.accessCode;
  toast("Novo código gerado e já salvo. Passe-o ao cliente.", "sucesso");
}

async function removerAcessoCliente() {
  const id = document.getElementById("modalClienteId").value;
  if (!confirm("Remover o acesso deste cliente? Ele não conseguirá mais entrar.")) return;
  const r = await authFetch(`/api/admin/clients/${id}/login`, { method: "DELETE" });
  if (!r.ok) return toast("Não foi possível remover.", "erro");
  toast("Acesso removido.", "sucesso");
  fecharModalCliente();
  recarregarClientesDoModal();
}

let historicoCarregado = false;
let termoHistoricoSalvo = null;
let timerHistoricoBusca = null;

// Chamado a cada tecla no campo de busca (com debounce de 300ms)
function buscarHistorico() {
  clearTimeout(timerHistoricoBusca);
  timerHistoricoBusca = setTimeout(carregarHistorico, 300);
}

async function carregarHistorico() {
  const termo = document.getElementById("searchHistorico").value.toLowerCase().trim();
// busca ou mudança de termo vai ao servidor; termo vazio usa o cache
  if (!historicoCarregado || termo !== termoHistoricoSalvo) {
    document.getElementById("listaHistorico").innerHTML = `<div class="spinner"></div>`;
    try {
      comandasHistorico = await authFetchJson(
        "/api/comandas?q=" + encodeURIComponent(termo) + "&limite=30",
      );
      historicoCarregado = true;
      termoHistoricoSalvo = termo;
    } catch (e) {
      console.error("Erro ao carregar histórico:", e);
      toast("Erro ao carregar o histórico.", "erro");
    }
  }
  renderHistorico();
}

function renderHistorico() {
  const div = document.getElementById("listaHistorico");

  if (comandasHistorico.length === 0) {
    div.innerHTML = `<p style="text-align:center; color:#aaa; margin-top: 20px;">Nenhuma comanda finalizada ainda.</p>`;
    return;
  }

// a busca já volta filtrada do servidor (as 30 mais recentes)
  const filtrados = comandasHistorico.slice(0, 30);

  div.innerHTML = filtrados
    .map((c) => {
      const nomeCliente = c.cliente || "Cliente Deletado";
      const dataFormatada = formatarDataHora(c.data);
      const obsHtml = c.observacao
        ? `<div style="font-size: 12px; color: #c084fc; margin-top: 4px; font-style: italic;">📝 Obs: ${escHtml(c.observacao)}</div>`
        : "";

      let totalCreditoUsado = 0;
      const itensHtml = c.items
        .map((i) => {
          const subtotal = (i.price || 0) * (i.quantity || 1);
          if (i.paymentMethod === "Credito") totalCreditoUsado += subtotal;
          return `
                  <div style="font-size: 13px; color:#e9d5ff; margin-left: 10px; margin-top: 4px; display: flex; justify-content: space-between; align-items: center; width: 100%;">
                      <span style="flex: 1; text-align: left; padding-right: 10px;">- ${escHtml(i.name)} (x${i.quantity || 1}) <small style="color:#aaa;">(${escHtml(i.paymentMethod)})</small></span>
                      <span style="min-width: 90px; text-align: right; flex-shrink: 0;">R$ ${subtotal.toFixed(2)}</span>
                  </div>`;
        })
        .join("");

      const htmlCreditoUsado =
        totalCreditoUsado > 0
          ? `<div style="color: #f59e0b; font-size: 14px; margin-bottom: 4px;">💳 Crédito Usado: <b>R$ ${totalCreditoUsado.toFixed(2)}</b></div>`
          : "";

      return `
          <div class="list-item" style="align-items:flex-start;">
              <div style="width: 100%; display: flex; justify-content: space-between; margin-bottom: 4px;">
                  <strong style="color: #c084fc; font-size: 16px;">${escHtml(nomeCliente)}</strong>
                  <span style="font-size: 11px; color: #aaa;">${dataFormatada}</span>
              </div>
              ${obsHtml}
              <div style="width: 100%; margin-top: 6px;">${itensHtml}</div>
              <div style="margin-top: 10px; width: 100%; text-align: right; border-top: 1px dashed rgba(192, 132, 252, 0.2); padding-top: 8px;">
                  ${htmlCreditoUsado}
                  <strong style="color:#10b981; font-size: 15px;">Total Geral: R$ ${c.totalGeral.toFixed(2)}</strong>
              </div>
          </div>`;
    })
    .join("");
}

function renderNaoPagas() {
  const div = document.getElementById("listaNaoPagas");
  const termo = document.getElementById("searchNaoPagas").value.toLowerCase();

  let agrupados = {};
  fiadosPendentes.forEach((f) => {
    if (!agrupados[f.clientId]) agrupados[f.clientId] = { total: 0, itens: [] };
    agrupados[f.clientId].total += f.price * f.quantity;
    agrupados[f.clientId].itens.push(f);
  });

  const idsFiado = Object.keys(agrupados).filter((id) => {
    const c = clientes.find((cli) => cli.id == id);
    return c ? c.name.toLowerCase().includes(termo) : false;
  });

  if (idsFiado.length === 0) {
    div.innerHTML = `<p style="text-align:center; color:#aaa; margin-top: 20px;">Nenhum cliente devendo fiado!</p>`;
    return;
  }

  div.innerHTML = idsFiado
    .map((id) => {
      const c = clientes.find((cli) => cli.id == id);
      const nome = c ? c.name : "Desconhecido";
      const dados = agrupados[id];

      const itensHtml = dados.itens
        .map(
          (i) => `
          <div style="font-size: 13px; color:#e9d5ff; margin-left: 10px; margin-top: 8px; display:flex; justify-content:space-between; align-items:center; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom:5px;">
              <span>- ${escHtml(i.name)} (x${i.quantity})<br><small style="color:#aaa;">${new Date(i.data).toLocaleDateString()}</small></span>
              <div style="text-align:right;">
                  <span style="font-weight:bold;">R$ ${(i.price * i.quantity).toFixed(2)}</span><br>
                  <button class="btn-success" style="width:auto; padding:4px 8px; font-size:11px; margin-top:4px;" data-act="pagarFiadoUnico" data-valor="${escHtml(i.id)}">✅ Quitar Item</button>
              </div>
          </div>
      `,
        )
        .join("");

      return `
      <div class="list-item" style="border-left: 4px solid #e11d48;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="color: #c084fc; font-size: 17px;">${escHtml(nome)}</strong>
              <span style="color:#e11d48; font-weight:bold; font-size:16px;">Devendo: R$ ${dados.total.toFixed(2)}</span>
          </div>
          <div style="width:100%; margin-top:8px;">${itensHtml}</div>
          <button class="btn-success" style="margin-top:15px; font-size:14px;" data-act="pagarFiadoTotal" data-valor="${escHtml(id)}">💳 Quitar Toda a Dívida do Cliente</button>
      </div>`;
    })
    .join("");
}

async function pagarFiadoUnico(fiadoId) {
  if (confirm("Confirmar o recebimento deste item? Ele sairá das dívidas!")) {
    await authFetch(`/api/fiados/pagar/${fiadoId}`, { method: "PUT" });
    recarregarTudo();
  }
}

async function pagarFiadoTotal(clientId) {
  if (confirm("Deseja marcar TODOS os itens deste cliente como Pagos?")) {
    await authFetch(`/api/fiados/pagar-cliente/${clientId}`, { method: "PUT" });
    recarregarTudo();
  }
}

const tipoBackupLabel = {
  auto: "🕒 Automático",
  manual: "✋ Manual",
  "pre-restauracao": "🛟 Antes de restaurar",
};

// status do envio externo de backups (rclone), se configurado
async function backupStatusExterno() {
  const div = document.getElementById("statusBackupExterno");
  if (!div) return;
  try {
    const r = await authFetch("/api/admin/backups/externo");
    const s = await r.json();
    if (!s.remoto) {
      div.innerHTML = `<span style="color:#aaa;">☁️ Envio externo de backup não configurado (defina <code>RCLONE_REMOTE</code> no .env).</span>`;
      return;
    }
    if (s.ok === true) {
      div.innerHTML = `<span style="color:#10b981;">☁️ Enviados para <b>${escHtml(s.remoto)}</b> com sucesso.</span>`;
    } else if (s.ok === false) {
      div.innerHTML = `<span style="color:#f59e0b;">⚠️ Envio para <b>${escHtml(s.remoto)}</b> falhou. Confira no servidor.</span>`;
    } else {
      div.innerHTML = `<span style="color:#aaa;">☁️ Enviando para <b>${escHtml(s.remoto)}</b>...</span>`;
    }
  } catch (e) {
    div.innerHTML = "";
  }
}

async function backupCarregar() {
  const div = document.getElementById("listaBackups");
  backupStatusExterno();
  try {
    const r = await authFetch("/api/admin/backups");
    if (!r.ok) {
      const e = await r.json();
      div.innerHTML = `<p style="text-align:center; color:#f59e0b; font-size:13px;">${escHtml(e.error || "Erro ao listar backups.")}</p>`;
      return;
    }
    const lista = await r.json();
    if (lista.length === 0) {
      div.innerHTML = `<p style="text-align:center; color:#aaa; font-size:13px;">Nenhum backup ainda.</p>`;
      return;
    }
    div.innerHTML = lista
      .slice(0, 15)
      .map(
        (b) => `
        <div style="background: rgba(0,0,0,0.3); padding: 10px; border-radius: 8px; margin-top: 8px;">
          <div style="font-size: 13px; color: #e9d5ff;">
            <b>${tipoBackupLabel[b.tipo] || escHtml(b.tipo)}</b>
            <span style="color:#aaa;"> • ${new Date(b.data).toLocaleString("pt-BR")} • ${(b.tamanho / 1024).toFixed(0)} KB</span>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button data-act="backupBaixar" data-arg="${escHtml(b.nome)}" style="width:50%; margin:0; padding:8px; background:rgba(255,255,255,0.15); color:#fff; font-weight:600; cursor:pointer;">⬇️ Baixar</button>
            <button data-act="backupRestaurar" data-arg="${escHtml(b.nome)}" style="width:50%; margin:0; padding:8px; background:#e11d48; color:#fff; font-weight:600; cursor:pointer;">♻️ Restaurar</button>
          </div>
        </div>`,
      )
      .join("");
  } catch (e) {
    div.innerHTML = `<p style="text-align:center; color:#f59e0b; font-size:13px;">Não foi possível conectar ao servidor.</p>`;
  }
}

async function backupCriar() {
  const r = await authFetch("/api/admin/backups", { method: "POST" });
  if (r.ok) toast("Backup criado!", "sucesso");
  else toast("Erro: " + ((await r.json()).error || "falha ao criar backup."), "erro");
  backupCarregar();
}

async function backupBaixar(nome) {
  const r = await authFetch(`/api/admin/backups/${encodeURIComponent(nome)}/download`);
  if (!r.ok) return toast("Erro ao baixar o backup.", "erro");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function backupRestaurar(nome) {
  if (!confirm("ATENÇÃO: todos os dados atuais serão SUBSTITUÍDOS por este backup.\n\n(Antes, o sistema guarda uma cópia do estado atual, por segurança.)\n\nDeseja continuar?"))
    return;
  const r = await authFetch(`/api/admin/backups/${encodeURIComponent(nome)}/restaurar`, { method: "POST" });
  if (r.ok) {
    toast("Backup restaurado com sucesso! A página será recarregada.", "sucesso");
    setTimeout(() => location.reload(), 1200);
  } else {
    toast("Erro: " + ((await r.json()).error || "falha ao restaurar."), "erro");
  }
}

async function backupRestaurarUpload() {
  const f = document.getElementById("backupArquivo").files[0];
  if (!f) return toast("Escolha um arquivo .sqlite primeiro.", "erro");
  if (!confirm(`ATENÇÃO: todos os dados atuais serão SUBSTITUÍDOS pelo arquivo "${f.name}".\n\nDeseja continuar?`)) return;
  if (f.size > 100 * 1024 * 1024) return toast("Arquivo grande demais (limite 100 MB).", "erro");
  const r = await authFetch("/api/admin/restaurar-upload", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: f,
  });
  if (r.ok) {
    toast("Backup restaurado com sucesso! A página será recarregada.", "sucesso");
    setTimeout(() => location.reload(), 1200);
  } else {
    toast("Erro: " + ((await r.json()).error || "falha ao restaurar."), "erro");
  }
}
