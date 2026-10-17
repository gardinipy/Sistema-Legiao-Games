async function enviarLoginCliente(event) {
  event.preventDefault();
  const login = document.getElementById("clientLogin").value.trim();
  const accessCode = document.getElementById("clientAccessCode").value;
  const btn = document.getElementById("btnEntrarCliente");
  const erroBox = document.getElementById("clientLoginErro");

  if (!login || !accessCode) {
    erroBox.textContent = "Preencha login e código de acesso.";
    erroBox.style.display = "block";
    return false;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";
  erroBox.style.display = "none";

  try {
    const r = await fetch("/api/client-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login, accessCode }),
    });
    const data = await r.json();
    if (!r.ok) {
      erroBox.textContent = data.error || "Não foi possível entrar.";
      erroBox.style.display = "block";
      return false;
    }
    setToken(data.token);
    localStorage.setItem("tipo_sessao", "client");
    document.getElementById("clientAccessCode").value = "";
    mostrarPainelCliente();
  } catch (e) {
    erroBox.textContent = "Erro de conexão com o servidor.";
    erroBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
  return false;
}
