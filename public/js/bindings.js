// Liga todos os eventos da interface. Com a CSP a mando, NENHUM handler
// fica no HTML inline: botões estáticos recebem data-act / data-tab e o
// conteúdo gerado dinamicamente é tratado por delegação de eventos.

// Logos quebrados somem sozinhos (punho pelo antigo onerror inline)
document.addEventListener(
  "error",
  (e) => {
    if (e.target && e.target.tagName === "IMG") e.target.style.display = "none";
  },
  true, // o evento "error" não borbulha; precisa da fase de captura
);

// Ações disparadas por clique: data-act + argumentos vindos de data-*
// (os nomes das funções são os mesmos já existentes nos outros arquivos)
const ACOES_CLICK = {
  mostrarLoginCliente: { fn: "mostrarLoginCliente", args: [] },
  mostrarLoginAdmin: { fn: "mostrarLoginAdmin", args: [] },
  fazerLogoutCliente: { fn: "fazerLogoutCliente", args: [] },
  fazerLogoutAdmin: { fn: "fazerLogoutAdmin", args: [] },
  abrirNovaComanda: { fn: "abrirNovaComanda", args: [] },
  addProduto: { fn: "addProduto", args: [] },
  addCliente: { fn: "addCliente", args: [] },
  baixarRelatorioExcel: { fn: "baixarRelatorioExcel", args: [] },
  backupCriar: { fn: "backupCriar", args: [] },
  backupRestaurarUpload: { fn: "backupRestaurarUpload", args: [] },
  fecharModalCredito: { fn: "fecharModalCredito", args: [] },
  salvarModalCredito: { fn: "salvarModalCredito", args: [] },
  fecharModalProduto: { fn: "fecharModalProduto", args: [] },
  salvarModalProduto: { fn: "salvarModalProduto", args: [] },
  fecharModalCliente: { fn: "fecharModalCliente", args: [] },
  salvarModalCliente: { fn: "salvarModalCliente", args: [] },
  gerarCodigoNoModal: { fn: "gerarCodigoNoModal", args: [] },
  resetarCodigoDoModal: { fn: "resetarCodigoDoModal", args: [] },
  removerAcessoCliente: { fn: "removerAcessoCliente", args: [] },
  removerItemCard: { fn: "removerItemCard", args: ["clientId", "index"] },
  alterarQtd: { fn: "alterarQtd", args: ["clientId", "index", "delta"] },
  editarValorItem: { fn: "editarValorItem", args: ["clientId", "index"] },
  apagarComandaInteira: { fn: "apagarComandaInteira", args: ["clientId"] },
  adicionarMaisNoCard: { fn: "adicionarMaisNoCard", args: ["clientId"] },
  finalizarComandaCard: { fn: "finalizarComandaCard", args: ["clientId"] },
  selecionarClienteCriar: { fn: "selecionarClienteCriar", args: ["valor"] },
  selecionarProdutoCriar: { fn: "selecionarProdutoCriar", args: ["valor"] },
  abrirModalProduto: { fn: "abrirModalProduto", args: ["valor"] },
  delProduto: { fn: "delProduto", args: ["valor"] },
  abrirModalCredito: { fn: "abrirModalCredito", args: ["valor", "index"] },
  apagarCredito: { fn: "apagarCredito", args: ["valor", "index"] },
  abrirModalCliente: { fn: "abrirModalCliente", args: ["valor"] },
  excluirCliente: { fn: "excluirCliente", args: ["valor"] },
  pagarFiadoUnico: { fn: "pagarFiadoUnico", args: ["valor"] },
  pagarFiadoTotal: { fn: "pagarFiadoTotal", args: ["valor"] },
  backupBaixar: { fn: "backupBaixar", args: ["arg"] },
  backupRestaurar: { fn: "backupRestaurar", args: ["arg"] },
};

// Eventos de input/change: além dos data-*, o valor do campo entra como
// último argumento (ex.: atualizarObservacao(clientId, valor))
const ACOES_VALOR = {
  atualizarObservacao: { fn: "atualizarObservacao", args: ["clientId"] },
  mudarPagamentoCard: { fn: "mudarPagamentoCard", args: ["clientId", "index"] },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const acao = ACOES_CLICK[el.dataset.act];
  if (!acao) return;
  const fn = window[acao.fn];
  if (typeof fn !== "function") return;
  const argv = acao.args.map((nome) => el.dataset[nome]);
  fn(...argv);
});

["input", "change"].forEach((tipo) => {
  document.addEventListener(tipo, (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const acao = ACOES_VALOR[el.dataset.act];
    if (!acao) return;
    const fn = window[acao.fn];
    if (typeof fn !== "function") return;
    const argv = acao.args.map((nome) => el.dataset[nome]);
    fn(...argv, e.target.value);
  });
});

// Abas do painel do admin
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  if (typeof showTab === "function") showTab(btn.dataset.tab);
});

// Formulários de login
document.addEventListener("DOMContentLoaded", () => {
  const formCliente = document.getElementById("formLoginCliente");
  if (formCliente)
    formCliente.addEventListener("submit", (e) => enviarLoginCliente(e));

  const formAdmin = document.getElementById("formLoginAdmin");
  if (formAdmin) formAdmin.addEventListener("submit", (e) => enviarLoginAdmin(e));

  const buscaHistorico = document.getElementById("searchHistorico");
  if (buscaHistorico) buscaHistorico.addEventListener("input", buscarHistorico);

  // Combos de cliente/produto (foco seleciona o texto e abre a lista;
  // Enter confirma a primeira opção do filtro)
  const campoCliente = document.getElementById("searchClienteCriar");
  if (campoCliente) {
    campoCliente.addEventListener("input", digitarClienteCriar);
    campoCliente.addEventListener("focus", () => {
      campoCliente.select();
      abrirListaClienteCriar();
    });
    campoCliente.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        enterClienteCriar();
      }
    });
  }

  const campoProduto = document.getElementById("searchProdutoCriar");
  if (campoProduto) {
    campoProduto.addEventListener("input", digitarProdutoCriar);
    campoProduto.addEventListener("focus", () => {
      campoProduto.select();
      abrirListaProdutoCriar();
    });
    campoProduto.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        enterProdutoCriar();
      }
    });
  }
});
