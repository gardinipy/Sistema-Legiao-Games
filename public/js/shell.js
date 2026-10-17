// Controla qual tela está visível. A home é o login do cliente.
const VIEWS = ["viewClientLogin", "viewClientPanel", "viewAdminLogin", "viewAdminPanel"];

function mostrarView(id) {
  VIEWS.forEach((v) => document.getElementById(v).classList.toggle("hidden", v !== id));
  window.scrollTo(0, 0);
}

function mostrarErro(idCaixa, mensagem) {
  const box = document.getElementById(idCaixa);
  if (!box) return;
  box.textContent = mensagem || "";
  box.style.display = mensagem ? "block" : "none";
}

function mostrarLoginCliente(mensagem) {
  mostrarView("viewClientLogin");
  mostrarErro("clientLoginErro", mensagem);
  setTimeout(() => document.getElementById("clientLogin")?.focus(), 50);
}

function mostrarLoginAdmin(mensagem) {
  mostrarView("viewAdminLogin");
  mostrarErro("loginErro", mensagem);
  setTimeout(() => document.getElementById("loginUsuario")?.focus(), 50);
}

function mostrarPainelCliente() {
  mostrarView("viewClientPanel");
  carregarDadosCliente();
}

function mostrarPainelAdmin() {
  mostrarView("viewAdminPanel");
  carregarDadosGerais();
}

// Chamado pelo authFetch quando o servidor responde 401 (sessão caiu)
function mostrarLogin(mensagem) {
  const tipo = localStorage.getItem("tipo_sessao");
  localStorage.removeItem("tipo_sessao");
  if (tipo === "admin") mostrarLoginAdmin(mensagem);
  else mostrarLoginCliente(mensagem);
}

async function iniciarApp() {
  const token = getToken();
  const tipo = localStorage.getItem("tipo_sessao");

  if (token && tipo) {
    try {
      const r = await fetch("/api/me", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) {
        const data = await r.json();
        return data.tipo === "admin" ? mostrarPainelAdmin() : mostrarPainelCliente();
      }
      clearToken();
      localStorage.removeItem("tipo_sessao");
    } catch (e) {
      // sem conexão: abre o painel da sessão guardada; as chamadas tratam o erro
      return tipo === "admin" ? mostrarPainelAdmin() : mostrarPainelCliente();
    }
  }
  mostrarLoginCliente();
}

function encerrarSessao() {
  authFetch("/api/logout", { method: "POST" }).catch(() => {});
  clearToken();
  localStorage.removeItem("tipo_sessao");
  dadosCarregados = false; // admin: não reaproveitar dados de outra sessão
  mostrarLoginCliente();
  toast("Sessão encerrada.", "info");
}
function fazerLogoutCliente() { encerrarSessao(); }
function fazerLogoutAdmin() { encerrarSessao(); }

document.addEventListener("DOMContentLoaded", iniciarApp);
