async function enviarLoginAdmin(event) {
  event.preventDefault();
  const usuario = document.getElementById("loginUsuario").value.trim();
  const senha = document.getElementById("loginSenha").value;
  const btn = document.getElementById("btnEntrarAdmin");
  const erroBox = document.getElementById("loginErro");

  if (!usuario || !senha) {
    erroBox.textContent = "Preencha email e senha.";
    erroBox.style.display = "block";
    return false;
  }

  btn.disabled = true;
  btn.textContent = "Entrando...";
  erroBox.style.display = "none";

  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
    });
    const data = await r.json();
    if (!r.ok) {
      erroBox.textContent = data.error || "Não foi possível entrar.";
      erroBox.style.display = "block";
      return false;
    }
    setToken(data.token);
    localStorage.setItem("tipo_sessao", "admin");
    document.getElementById("loginSenha").value = "";
    mostrarPainelAdmin();
  } catch (e) {
    erroBox.textContent = "Erro de conexão com o servidor.";
    erroBox.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
  return false;
}
