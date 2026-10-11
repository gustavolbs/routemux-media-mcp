export interface Env {
  IMAGES: R2Bucket;
  SECRET: string;
  ROUTEMUX_KEY: string;
  ROUTEMUX_BASE_URL: string;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

export function randomKey(ext: string): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "") + `.${ext}`;
}

// Trusts the bytes, not the Content-Type header.
export function sniffImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

async function routemuxError(res: Response): Promise<string> {
  const body = await res.text();
  try {
    const err = JSON.parse(body).error;
    const parts = [err.code, err.message, err.reference].filter(Boolean).join(" | ");
    if (parts) return `RouteMux error (HTTP ${res.status}): ${parts}`;
  } catch {
    // Not JSON, fall through to the raw body.
  }
  return `RouteMux error (HTTP ${res.status}): ${body.slice(0, 500)}`;
}

// Adds the key and turns RouteMux error responses into readable Errors.
export async function routemuxFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${env.ROUTEMUX_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(180_000),
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${env.ROUTEMUX_KEY}` },
  });
  if (res.status >= 400) throw new Error(await routemuxError(res));
  return res;
}

export async function loadSourceImage(env: Env, origin: string, imageUrl: string): Promise<File> {
  const url = new URL(imageUrl);
  let bytes: Uint8Array;
  // Our own images come straight from R2 instead of a Worker-to-itself fetch.
  if (url.origin === origin && url.pathname.startsWith("/img/")) {
    const object = await env.IMAGES.get(url.pathname.slice("/img/".length));
    if (!object) throw new Error(`Image not found (it may have expired): ${url.pathname}`);
    bytes = new Uint8Array(await object.arrayBuffer());
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download the image (HTTP ${res.status}).`);
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error("The image is larger than 10 MB.");
  const type = sniffImageType(bytes);
  if (!type) throw new Error("The image is not a PNG, JPEG or WebP file.");
  return new File([bytes], `image.${type.ext}`, { type: type.mime });
}

export async function asToolResult(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
