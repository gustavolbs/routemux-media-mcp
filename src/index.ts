import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  type Env,
  type ToolResult,
  MAX_UPLOAD_BYTES,
  asToolResult,
  loadSourceImage,
  randomKey,
  routemuxFetch,
  sniffImageType,
  text,
} from "./lib";
import { uploadPage } from "./upload-page";
import { registerVideoTools, serveVideo } from "./video";

const MODELS = {
  flare: "openai/gpt-image-2.5-flare",
  sunburst: "openai/gpt-image-2.5-sunburst",
} as const;

const FLUX_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

// Above this the base64 block gets too heavy for a chat tool result, so only the URL is returned.
const MAX_INLINE_BYTES = 700 * 1024;

async function saveImage(env: Env, origin: string, bytes: Uint8Array) {
  const type = sniffImageType(bytes);
  if (!type) throw new Error("Not a PNG, JPEG or WebP image.");
  const key = randomKey(type.ext);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type.mime } });
  return { url: `${origin}/img/${key}`, mime: type.mime };
}

async function requestImage(env: Env, path: string, init: RequestInit): Promise<Uint8Array> {
  const res = await routemuxFetch(env, path, init);
  const item = ((await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> }).data?.[0];
  if (item?.b64_json) return new Uint8Array(Buffer.from(item.b64_json, "base64"));
  if (item?.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`Could not download the generated image (HTTP ${img.status}).`);
    return new Uint8Array(await img.arrayBuffer());
  }
  throw new Error("RouteMux returned no image.");
}

// FLUX.2 klein on Workers AI: nearly free, good for simple images, weak at text.
async function requestFluxImage(env: Env, prompt: string, size?: string): Promise<Uint8Array> {
  const [width, height] = size && /^\d+x\d+$/.test(size) ? size.split("x") : ["1024", "1024"];
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", width);
  form.append("height", height);
  // Workers AI takes this model's input as a multipart body.
  const encoded = new Response(form);
  const input = { multipart: { body: encoded.body, contentType: encoded.headers.get("Content-Type") } };
  const output = (await env.AI.run(FLUX_MODEL as never, input as never)) as { image?: string };
  if (!output.image) throw new Error("Workers AI returned no image.");
  return new Uint8Array(Buffer.from(output.image, "base64"));
}

async function imageResult(env: Env, origin: string, bytes: Uint8Array): Promise<ToolResult> {
  const { url, mime } = await saveImage(env, origin, bytes);
  const result = text(url);
  if (bytes.byteLength <= MAX_INLINE_BYTES) {
    result.content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime });
  }
  return result;
}

function createServer(env: Env, origin: string) {
  const server = new McpServer(
    { name: "routemux-media", version: "1.4.0" },
    {
      instructions: [
        "These tools cannot see images the user attaches in the chat: edit_image and create_video need image URLs.",
        "When the user attaches an image, upload it yourself if you have a code execution sandbox: call get_upload_link, then run",
        '`curl -sS -F "file=@<path to the attachment>" "<upload link>"` (attachments are usually under /mnt/user-data/uploads)',
        "and use the `url` field of the JSON reply as the image URL. The upload takes PNG, JPEG or WebP up to 10 MB, so convert or downscale first if needed.",
        "Only when you have no sandbox, cannot read the file, or the request is blocked, give the user the upload link and ask them to paste back the URL the page returns.",
      ].join(" "),
    },
  );

  server.registerTool(
    "generate_image",
    {
      description: [
        "Generate an image from a text prompt. Returns a public URL (and the image inline when small enough). Takes up to a minute.",
        'Choosing the model: use "flux" for simple images with no text in them, such as illustrations, coloring pages, line art, backgrounds and quick drafts; it is nearly free.',
        'Use "flare" for anything with text or lettering, logos, precise layouts, realistic people, or when the user wants the best result; it costs about US$ 0.02 per image.',
        '"sunburst" costs the same as flare and is slower but more precise.',
      ].join(" "),
      inputSchema: {
        prompt: z.string().describe("What to draw."),
        model: z.enum(["flare", "sunburst", "flux"]).default("flare"),
        size: z
          .string()
          .optional()
          .describe('Optional shape: "1024x1024" (square), "1536x1024" (landscape), "1024x1536" (portrait) or "auto". The returned image can be larger.'),
        quality: z.string().optional().describe('Optional, e.g. "low", "medium", "high" or "auto". Ignored by flux.'),
      },
    },
    ({ prompt, model, size, quality }) =>
      asToolResult(async () => {
        if (model === "flux") return imageResult(env, origin, await requestFluxImage(env, prompt, size));
        const bytes = await requestImage(env, "/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODELS[model], prompt, n: 1, size, quality }),
        });
        return imageResult(env, origin, bytes);
      }),
  );

  server.registerTool(
    "edit_image",
    {
      description:
        "Edit an existing image following a text prompt. image_url can be any public image URL. For an image the user attached in the chat, get a URL first with get_upload_link. Returns a public URL (and the image inline when small enough).",
      inputSchema: {
        prompt: z.string().describe("What to change in the image."),
        image_url: z.string().url().describe("URL of the image to edit (PNG, JPEG or WebP, up to 10 MB)."),
        model: z.enum(["flare", "sunburst"]).default("sunburst"),
      },
    },
    ({ prompt, image_url, model }) =>
      asToolResult(async () => {
        const form = new FormData();
        form.append("model", MODELS[model]);
        form.append("prompt", prompt);
        form.append("image", await loadSourceImage(env, origin, image_url));
        const bytes = await requestImage(env, "/images/edits", { method: "POST", body: form });
        return imageResult(env, origin, bytes);
      }),
  );

  server.registerTool(
    "get_upload_link",
    {
      description:
        'Return the upload link, used to turn an image attached in the chat into a URL for edit_image or create_video. Preferred: upload the attachment yourself from your code execution sandbox with `curl -sS -F "file=@<path>" "<link>"`; the JSON reply has the `url`. Fallback: the same link opens a page where the user can upload the photo and copy the URL. The link contains a secret, so only show it to the user when they need the fallback.',
      inputSchema: {},
    },
    async () => text(`${origin}/upload/${env.SECRET}`),
  );

  registerVideoTools(server, env, origin);
  return server;
}

async function handleUpload(request: Request, env: Env, origin: string): Promise<Response> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_UPLOAD_BYTES + 4096) {
    return Response.json({ error: "File is larger than 10 MB." }, { status: 413 });
  }
  const file = (await request.formData().catch(() => null))?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "Missing file." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "File is larger than 10 MB." }, { status: 413 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!sniffImageType(bytes)) {
    return Response.json({ error: "Only PNG, JPEG or WebP images are accepted." }, { status: 415 });
  }
  const { url } = await saveImage(env, origin, bytes);
  return Response.json({ url });
}

async function serveImage(env: Env, key: string): Promise<Response> {
  // Image keys are flat; anything with a slash is a video or a job record.
  const object = key.includes("/") ? null : await env.IMAGES.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { origin, pathname } = url;

    if (request.method === "GET" && pathname.startsWith("/img/")) {
      return serveImage(env, pathname.slice("/img/".length));
    }
    if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/vid/")) {
      return serveVideo(request, env, pathname.slice("/vid/".length));
    }

    // Fail closed if SECRET was never set, so "/mcp/undefined" can't match.
    if (env.SECRET) {
      if (pathname === `/upload/${env.SECRET}`) {
        if (request.method === "GET") {
          return new Response(uploadPage, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (request.method === "POST") return handleUpload(request, env, origin);
      }
      if (pathname === `/mcp/${env.SECRET}`) {
        return createMcpHandler(() => createServer(env, origin), { route: pathname })(request, env, ctx);
      }
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
