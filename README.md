# routemux-media-mcp

MCP server remoto (Cloudflare Workers + R2) para gerar e editar imagens e gerar vídeos pela
[RouteMux](https://routemux.com). Feito para ser usado como custom connector no Claude,
inclusive no celular.

## Tools

| Tool | O que faz |
|---|---|
| `generate_image(prompt, model?, size?, quality?)` | Gera uma imagem. `model`: `flare` (padrão), `sunburst` (mais preciso) ou `flux` (quase grátis, para imagens simples). |
| `edit_image(prompt, image_url, model?)` | Edita uma imagem a partir de uma URL. Padrão `sunburst`. |
| `get_upload_link()` | Devolve o link de upload, usado para transformar uma foto anexada no chat em URL. |
| `create_video(prompt, model?, seconds?, size?, ratio?)` | Cria um job de vídeo (texto→vídeo) e devolve na hora o `job_id` e o custo estimado. |
| `get_video(job_id)` | Consulta o job. Quando termina, salva o MP4 no R2 e devolve a URL. |

As imagens e os vídeos ficam no R2 com chave aleatória longa e são servidos pelo próprio Worker
em `/img/<key>` e `/vid/<key>` (com suporte a Range). Imagens pequenas também voltam inline no chat.

### Modelos de imagem

| `model` | Onde roda | Custo | Para quê |
|---|---|---|---|
| `flare` (padrão) | GPT Image 2.5 na RouteMux | US$ 0,0186 | Texto na imagem, logos, layouts precisos, resultado final |
| `sunburst` | GPT Image 2.5 na RouteMux | US$ 0,0186 | Igual ao flare, mais lento e mais preciso; padrão da edição |
| `flux` | FLUX.2 klein no Workers AI | ~104 neurons (~US$ 0,001) | Imagens simples sem texto: ilustrações, desenhos para colorir, rascunhos |

Quem escolhe é o Claude, seguindo a descrição da tool e o que você pedir ("usa o flux", "faz um
rascunho"). Não há troca automática entre modelos. O `flux` usa a cota do Workers AI: 10.000
neurons grátis por dia (umas 96 imagens 1024x1024); passando disso, no plano gratuito a chamada
falha em vez de cobrar. Ele erra texto dentro da imagem e não é usado na edição.

### Vídeo

| | `hailuo` (padrão) | `h3` |
|---|---|---|
| Modelo | `minimax/minimax-hailuo-2.3` | `minimax/minimax-h3` |
| `seconds` | 6 (padrão) ou 10 | 4 a 15 (padrão 5) |
| `size` | `768P` (padrão) ou `1080P` (só com 6 s) | `768P` (padrão) ou `2K` |
| `ratio` | não tem | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9` |
| Custo | US$ 0,056 (768P, 6 s), US$ 0,112 (10 s ou 1080P) | US$ 0,08/s em 768P, US$ 0,13/s em 2K |

O vídeo é assíncrono: `create_video` devolve o `job_id` e o Claude consulta `get_video` até
ficar pronto (alguns minutos). Um job que falha não é cobrado. Depois de salvo, `get_video`
devolve sempre a mesma URL, sem baixar de novo.

Só texto→vídeo: a API da RouteMux ainda não aceita imagem (primeiro frame, último frame,
referências) nesses modelos. Ela recusa multipart e ignora campos de imagem no JSON, gerando e
cobrando um vídeo só de texto.

## Setup

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create routemux-images
npx wrangler r2 bucket lifecycle add routemux-images expire-30d "" --expire-days 30 -y
npx wrangler secret put SECRET        # um valor longo e aleatório, ex.: openssl rand -hex 32
npx wrangler secret put ROUTEMUX_KEY  # sua key da RouteMux
npx wrangler deploy
```

A regra de lifecycle apaga tudo no bucket (imagens, vídeos e registros de job) após 30 dias.
Se usar outro nome de bucket, troque também em `wrangler.jsonc`.

## Adicionar no Claude

1. No claude.ai (web ou desktop): Settings → Connectors → Add custom connector.
2. Nome: o que quiser. URL: `https://<worker>.workers.dev/mcp/<SECRET>`.
3. Salvar. O connector passa a aparecer também no app do celular.

Não há OAuth: o segredo no caminho é a autenticação. Quem tiver a URL usa sua key, então trate
a URL como senha. Para trocar, rode `wrangler secret put SECRET` de novo e atualize o connector.

## Foto anexada no chat

Uma tool de connector só recebe texto, então o Claude não consegue passar para ela a foto que
você anexou. Há dois caminhos:

1. **O Claude sobe a foto sozinho.** Com "Code execution and file creation" e "Allow network
   egress" ligados em Settings → Capabilities, o Claude envia o anexo do sandbox dele para o
   `/upload` e usa a URL. O servidor já instrui o Claude a tentar isso primeiro. Depende de o
   sandbox conseguir acessar o domínio do Worker.
2. **Página de upload.** Se o caminho 1 não estiver disponível, o Claude manda o link
   (`get_upload_link`); você envia a foto por ali e cola no chat a URL `/img/...` devolvida.

Aceita PNG, JPG e WebP até 10 MB.

## Teste local

```bash
cp .dev.vars.example .dev.vars   # preencha SECRET e ROUTEMUX_KEY
npx wrangler dev
npx @modelcontextprotocol/inspector   # Streamable HTTP, URL http://localhost:8787/mcp/<SECRET>
```

Upload por curl:

```bash
curl -X POST http://localhost:8787/upload/<SECRET> -F "file=@foto.jpg"
```

## Notas

- Os logs do Workers ficam desligados de propósito: o log de invocação grava a URL, e a URL
  contém o segredo. Pelo mesmo motivo, evite `wrangler tail` em telas compartilhadas.
- O Worker nunca carrega o vídeo inteiro em memória: o download da RouteMux vai em stream para
  o R2 (upload multipart em partes de 10 MB quando a RouteMux não informa o tamanho).
- Qualquer path fora dos listados, ou com segredo errado, responde 404.
