const TOKEN_KEY = "legiao_token";

// Escape de HTML para TODO texto vindo do servidor antes de entrar em
// innerHTML. Sem isso, um nome/código/observação com "<script>" executa.
// (CSP não é a defesa única: a regra é escapar para não confiar no dado.)
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function toast(mensagem, tipo = "info") {
  const host = document.getElementById("toastHost");
  if (!host) return alert(mensagem);
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.textContent = mensagem;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    el.style.transition = "all .25s ease";
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

// usado por tudo que exige login; em 401, limpa a sessão e volta pro login
async function authFetch(url, opts = {}) {
  const token = getToken();
  opts.headers = {
    ...(opts.headers || {}),
    ...(token ? { Authorization: "Bearer " + token } : {}),
  };
  const r = await fetch(url, opts);
  if (r.status === 401) {
    clearToken();
    if (typeof mostrarLogin === "function") {
      mostrarLogin("Sua sessão expirou. Faça login novamente.");
    }
    throw new Error("Não autenticado");
  }
  return r;
}

// Busca JSON autenticado e explica claramente se a rota não devolveu JSON
async function authFetchJson(url, opts = {}) {
  const r = await authFetch(url, opts);
  const texto = await r.text();
  try {
    return JSON.parse(texto);
  } catch (e) {
    throw new Error(
      `A rota ${url} não devolveu JSON (status ${r.status}). Resposta começa com: ${texto.slice(0, 40)}`,
    );
  }
}
