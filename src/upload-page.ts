export const uploadPage = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>Enviar imagem</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 28rem; margin: 0 auto; padding: 2rem 1rem; color: #111; background: #fafafa; }
  h1 { font-size: 1.25rem; }
  input[type=file], button { display: block; width: 100%; box-sizing: border-box; font: inherit; padding: .9rem; margin-top: 1rem; border-radius: .6rem; }
  input[type=file] { border: 1px dashed #999; background: #fff; }
  button { border: 0; background: #111; color: #fff; }
  button:disabled { opacity: .5; }
  #out { margin-top: 1.25rem; word-break: break-all; }
  #out input { width: 100%; box-sizing: border-box; font: inherit; padding: .7rem; border: 1px solid #ccc; border-radius: .6rem; }
  .err { color: #b00020; }
  @media (prefers-color-scheme: dark) {
    body { color: #eee; background: #111; }
    input[type=file], #out input { background: #1c1c1c; color: #eee; border-color: #555; }
    button { background: #eee; color: #111; }
    .err { color: #ff8a8a; }
  }
</style>
</head>
<body>
<h1>Enviar imagem</h1>
<p>PNG, JPG ou WebP, até 10 MB.</p>
<form id="form">
  <input id="file" type="file" name="file" accept="image/png,image/jpeg,image/webp" required>
  <button id="send">Enviar</button>
</form>
<div id="out"></div>
<script>
  const form = document.getElementById("form");
  const send = document.getElementById("send");
  const out = document.getElementById("out");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    send.disabled = true;
    out.textContent = "Enviando...";
    out.className = "";
    try {
      const res = await fetch(location.href, { method: "POST", body: new FormData(form) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha no envio.");
      out.innerHTML = '<p>Pronto. Cole esta URL no chat:</p><input id="url" readonly><button id="copy" type="button">Copiar</button>';
      const field = document.getElementById("url");
      field.value = data.url;
      document.getElementById("copy").onclick = async (e) => {
        await navigator.clipboard.writeText(data.url);
        e.target.textContent = "Copiado";
      };
    } catch (error) {
      out.textContent = error.message;
      out.className = "err";
    } finally {
      send.disabled = false;
    }
  });
</script>
</body>
</html>`;
