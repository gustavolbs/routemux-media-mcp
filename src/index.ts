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

async function imageResult(env: Env, origin: string, bytes: Uint8Array): Promise<ToolResult> {
  const { url, mime } = await saveImage(env, origin, bytes);
  const result = text(url);
  if (bytes.byteLength <= MAX_INLINE_BYTES) {
    result.content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: mime });
  }
  return result;
}

function createServer(env: Env, origin: string) {
  const server = new McpServer({ name: "routemux-media", version: "1.1.0" });

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image from a text prompt. Returns a public URL (and the image inline when small enough). Takes up to a minute.",
      inputSchema: {
        prompt: z.string().describe("What to draw."),
        model: z.enum(["flare", "sunburst"]).default("flare").describe("flare is fast, sunburst is more precise."),
        size: z
          .string()
          .optional()
          .describe('Optional shape: "1024x1024" (square), "1536x1024" (landscape), "1024x1536" (portrait) or "auto". The returned image can be larger.'),
        quality: z.string().optional().describe('Optional, e.g. "low", "medium", "high" or "auto".'),
      },
    },
    ({ prompt, model, size, quality }) =>
      asToolResult(async () => {
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
        "Edit an existing image following a text prompt. image_url can be any public image URL, including one from get_upload_link. Returns a public URL (and the image inline when small enough).",
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
        "Return the link to a page where the user can upload a photo from their device. The page gives back an image URL to use with edit_image or as a frame in create_video.",
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
