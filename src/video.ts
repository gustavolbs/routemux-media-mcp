import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Env, type ToolResult, asToolResult, loadSourceImage, randomKey, routemuxFetch, text } from "./lib";

const VIDEO_MODELS = {
  hailuo: "minimax/minimax-hailuo-2.3",
  h3: "minimax/minimax-h3",
} as const;

const H3_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const JOB_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const PART_BYTES = 10 * 1024 * 1024;

type VideoInput = {
  model: keyof typeof VIDEO_MODELS;
  seconds?: number;
  size?: string;
  ratio?: string;
  first_frame_url?: string;
  last_frame_url?: string;
  reference_image_urls?: string[];
};

// Validates the options against what each model accepts and estimates the cost.
function planVideo(input: VideoInput): { seconds: number; size: string; costUsd: number } {
  const size = (input.size ?? "768P").toUpperCase();
  const references = input.reference_image_urls ?? [];
  if (input.last_frame_url && !input.first_frame_url) {
    throw new Error("last_frame_url needs first_frame_url as well.");
  }

  if (input.model === "hailuo") {
    const seconds = input.seconds ?? 6;
    if (seconds !== 6 && seconds !== 10) throw new Error("hailuo accepts seconds = 6 or 10.");
    if (size !== "768P" && size !== "1080P") throw new Error('hailuo accepts size = "768P" or "1080P".');
    if (size === "1080P" && seconds !== 6) throw new Error("hailuo at 1080P only supports 6 seconds.");
    if (input.ratio) throw new Error("ratio is only supported by h3.");
    if (input.last_frame_url || references.length > 0) {
      throw new Error("hailuo only supports first_frame_url. Use h3 for a last frame or reference images.");
    }
    const costUsd = size === "1080P" || seconds === 10 ? 0.112 : 0.056;
    return { seconds, size, costUsd };
  }

  const seconds = input.seconds ?? 5;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 15) {
    throw new Error("h3 accepts seconds from 4 to 15.");
  }
  if (size !== "768P" && size !== "2K") throw new Error('h3 accepts size = "768P" or "2K".');
  if (input.ratio && !H3_RATIOS.includes(input.ratio)) {
    throw new Error(`h3 accepts ratio = ${H3_RATIOS.join(", ")}.`);
  }
  return { seconds, size, costUsd: seconds * (size === "2K" ? 0.13 : 0.08) };
}

async function createVideo(env: Env, origin: string, prompt: string, input: VideoInput): Promise<ToolResult> {
  const { seconds, size, costUsd } = planVideo(input);
  const fields: Record<string, string | number> = { model: VIDEO_MODELS[input.model], prompt, seconds, size };
  if (input.ratio) fields.ratio = input.ratio;

  const references = input.reference_image_urls ?? [];
  let init: RequestInit;
  if (input.first_frame_url || references.length > 0) {
    // Image inputs go as multipart files, text-only jobs as JSON.
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, String(value));
    if (input.first_frame_url) form.append("input_reference", await loadSourceImage(env, origin, input.first_frame_url));
    if (input.last_frame_url) form.append("last_frame", await loadSourceImage(env, origin, input.last_frame_url));
    for (const url of references) form.append("reference_images", await loadSourceImage(env, origin, url));
    init = { method: "POST", body: form };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) };
  }

  const job = (await (await routemuxFetch(env, "/videos", init)).json()) as { id?: string; status?: string };
  if (!job.id) throw new Error("RouteMux accepted the request but returned no job id.");
  return text(
    [
      `job_id: ${job.id}`,
      `status: ${job.status ?? "queued"}`,
      `estimated cost: US$ ${costUsd.toFixed(2)} (${input.model}, ${seconds} s, ${size}), billed only if the job succeeds`,
      "The video takes a few minutes. Call get_video with this job_id to check on it.",
    ].join("\n"),
  );
}

async function saveVideo(env: Env, res: Response): Promise<string> {
  const key = randomKey("mp4");
  const options = { httpMetadata: { contentType: "video/mp4" } };
  const length = Number(res.headers.get("Content-Length"));
  const body = res.body!;

  // Never buffer the whole file: stream straight to R2 when the size is known...
  if (length > 0) {
    await env.IMAGES.put(`vid/${key}`, body.pipeThrough(new FixedLengthStream(length)), options);
    return key;
  }

  // ...otherwise upload in fixed-size parts, holding one part in memory at a time.
  const upload = await env.IMAGES.createMultipartUpload(`vid/${key}`, options);
  try {
    const parts: R2UploadedPart[] = [];
    const buffer = new Uint8Array(PART_BYTES);
    let filled = 0;
    const flush = async () => {
      parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, filled)));
      filled = 0;
    };
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; ) {
        const take = Math.min(PART_BYTES - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === PART_BYTES) await flush();
      }
    }
    if (filled > 0 || parts.length === 0) await flush();
    await upload.complete(parts);
  } catch (error) {
    await upload.abort();
    throw error;
  }
  return key;
}

async function getVideo(env: Env, origin: string, jobId: string): Promise<ToolResult> {
  if (!JOB_ID.test(jobId)) throw new Error("Invalid job_id.");

  const saved = await env.IMAGES.get(`job/${jobId}`);
  if (saved) return text(`${origin}/vid/${await saved.text()}`);

  const job = (await (await routemuxFetch(env, `/videos/${jobId}`)).json()) as {
    status?: string;
    progress?: number;
    error?: { code?: string; message?: string } | string;
  };

  if (job.status === "completed") {
    // The content endpoint may redirect to a signed URL; follow it by hand so the key is not sent there.
    let res = await routemuxFetch(env, `/videos/${jobId}/content`, { redirect: "manual" });
    const location = res.headers.get("Location");
    if (res.status >= 300 && location) res = await fetch(new URL(location, env.ROUTEMUX_BASE_URL));
    if (!res.ok || !res.body || res.headers.get("Content-Type")?.includes("json")) {
      throw new Error(`The video is ready but could not be downloaded (HTTP ${res.status}). Try get_video again.`);
    }
    const key = await saveVideo(env, res);
    await env.IMAGES.put(`job/${jobId}`, key);
    return text(`${origin}/vid/${key}`);
  }

  if (job.status === "failed" || job.status === "cancelled" || job.status === "expired") {
    const reason = typeof job.error === "string" ? job.error : [job.error?.code, job.error?.message].filter(Boolean).join(" | ");
    return { ...text(`Video job ${job.status}${reason ? `: ${reason}` : "."} It was not billed.`), isError: true };
  }

  const progress = typeof job.progress === "number" ? `, progress: ${job.progress}%` : "";
  return text(`status: ${job.status ?? "unknown"}${progress}. Not ready yet, call get_video again in about 30 seconds.`);
}

export function registerVideoTools(server: McpServer, env: Env, origin: string) {
  server.registerTool(
    "create_video",
    {
      description: [
        "Start an asynchronous video generation job. Returns immediately with a job_id and the estimated cost; the video itself takes a few minutes.",
        "How to use: call create_video, tell the user the estimated cost, then call get_video with the job_id every 30 seconds or so until it returns a video URL.",
        "Each call is billed, so never submit the same job twice; poll the existing job_id instead.",
        'Models: "hailuo" (default) is cheap, about US$ 0.06 per video, good for tests and drafts. "h3" is expensive, US$ 0.08 per second or more (about US$ 0.40 for 5 s and US$ 1.20 for 15 s), so try the idea with hailuo first and only use h3 when the user asks for it.',
        "Image URLs come from generate_image, edit_image or get_upload_link.",
      ].join(" "),
      inputSchema: {
        prompt: z.string().describe("What happens in the video: subject, action, setting, camera movement, style."),
        model: z.enum(["hailuo", "h3"]).default("hailuo"),
        seconds: z.number().int().optional().describe("hailuo: 6 (default) or 10. h3: 4 to 15 (default 5)."),
        size: z
          .string()
          .optional()
          .describe('Resolution. hailuo: "768P" (default) or "1080P" (1080P only with 6 seconds). h3: "768P" (default) or "2K".'),
        ratio: z.string().optional().describe('h3 only: "16:9" (default), "9:16", "1:1", "4:3", "3:4" or "21:9".'),
        first_frame_url: z.string().url().optional().describe("Image the video starts from (image-to-video)."),
        last_frame_url: z.string().url().optional().describe("h3 only: image the video ends on. Needs first_frame_url."),
        reference_image_urls: z.array(z.string().url()).optional().describe("h3 only: reference images to guide the video."),
      },
    },
    ({ prompt, ...input }) => asToolResult(() => createVideo(env, origin, prompt, input)),
  );

  server.registerTool(
    "get_video",
    {
      description:
        "Check a video job started with create_video. While it is running, returns the status (and progress when available): wait about 30 seconds and call again. When it is done, returns the public URL of the MP4. Calling it again after that returns the same URL.",
      inputSchema: { job_id: z.string().describe("The job_id returned by create_video.") },
    },
    ({ job_id }) => asToolResult(() => getVideo(env, origin, job_id)),
  );
}

// R2 reports the served range as offset/length or as a suffix, depending on the request.
function rangeBounds(range: R2Range, size: number): { offset: number; length: number } {
  const { offset, length, suffix } = range as { offset?: number; length?: number; suffix?: number };
  const start = offset ?? (suffix !== undefined ? Math.max(size - suffix, 0) : 0);
  return { offset: start, length: Math.min(length ?? size - start, size - start) };
}

// GET/HEAD /vid/<key> with Range support, which phones need to play and seek.
export async function serveVideo(request: Request, env: Env, key: string): Promise<Response> {
  if (key.includes("/")) return new Response("Not found", { status: 404 });
  const wantsRange = request.headers.has("Range");
  let object: R2Object | R2ObjectBody | null;
  try {
    object =
      request.method === "HEAD"
        ? await env.IMAGES.head(`vid/${key}`)
        : await env.IMAGES.get(`vid/${key}`, wantsRange ? { range: request.headers } : {});
  } catch {
    return new Response("Range not satisfiable", { status: 416 });
  }
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400",
    ETag: object.httpEtag,
  });
  let status = 200;
  let length = object.size;
  if (wantsRange && object.range) {
    const bounds = rangeBounds(object.range, object.size);
    if (bounds.length <= 0) {
      return new Response("Range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${object.size}` } });
    }
    headers.set("Content-Range", `bytes ${bounds.offset}-${bounds.offset + bounds.length - 1}/${object.size}`);
    length = bounds.length;
    status = 206;
  }
  headers.set("Content-Length", String(length));
  return new Response("body" in object ? (object as R2ObjectBody).body : null, { status, headers });
}
