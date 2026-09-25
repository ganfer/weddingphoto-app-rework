const SESSION_COOKIE = "wedding_gallery_session";
const SESSION_SECONDS = 24 * 60 * 60;
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
      const token = url.searchParams.get("token") || "";
      const role = await roleForPassword(token, env);
      if (role) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: "/",
            "Set-Cookie": await createSessionCookie(role, env),
            "Cache-Control": "no-store"
          }
        });
      }
      return Response.redirect(url.origin + "/?access=denied", 302);
    }

    if (url.pathname === "/api/session" && request.method === "GET") {
      const session = await readSession(request, env);
      return json({ authenticated: Boolean(session), role: session?.role || null, appName: env.APP_NAME || "Wedding Photo Gallery" }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
      const role = await roleForPassword(String(body.password || ""), env);
      if (!role) return json({ error: "Das Passwort stimmt nicht." }, 401, { "Cache-Control": "no-store" });
      return json({ authenticated: true, role }, 200, {
        "Set-Cookie": await createSessionCookie(role, env),
        "Cache-Control": "no-store"
      });
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" });
    }

    if (url.pathname.startsWith("/api/")) {
      const session = await readSession(request, env);
      if (!session) return json({ error: "Anmeldung erforderlich." }, 401, { "Cache-Control": "no-store" });
      try {
        if (url.pathname === "/api/gallery" && request.method === "GET") return await listGallery(env);
        if (url.pathname === "/api/upload" && request.method === "POST") return await uploadImages(request, env);
        const imageMatch = url.pathname.match(/^\/api\/images\/(\d+)$/);
        if (imageMatch && request.method === "GET") return await serveImage(imageMatch[1], url.searchParams.get("size") || "thumb", env);
        const deleteMatch = url.pathname.match(/^\/api\/images\/(\d+)$/);
        if (deleteMatch && request.method === "DELETE") {
          if (session.role !== "admin") return json({ error: "Nur der Admin kann Bilder löschen." }, 403);
          return await deleteImage(deleteMatch[1], env);
        }
        return json({ error: "Endpunkt nicht gefunden." }, 404);
      } catch (error) {
        console.error("API request failed", error instanceof Error ? error.message : "unknown error");
        return json({ error: error instanceof Error ? error.message : "Interner Fehler." }, 502, { "Cache-Control": "no-store" });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};

async function roleForPassword(value, env) {
  if (!value || !env.GALLERY_ACCESS_TOKEN) return null;
  // Reusing the guest secret as the admin secret must never grant admin rights.
  if (env.ADMIN_ACCESS_TOKEN && env.ADMIN_ACCESS_TOKEN !== env.GALLERY_ACCESS_TOKEN && await constantTimeEqual(value, env.ADMIN_ACCESS_TOKEN)) return "admin";
  if (await constantTimeEqual(value, env.GALLERY_ACCESS_TOKEN)) return "guest";
  return null;
}

async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b)))
  ]);
  const x = new Uint8Array(left), y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function sign(value, env) {
  if (!env.SESSION_SIGNING_KEY) throw new Error("SESSION_SIGNING_KEY ist nicht konfiguriert.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function createSessionCookie(role, env) {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const signature = toBase64Url(await sign(payload, env));
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

async function readSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const value = cookie.split(";").map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value || !env.SESSION_SIGNING_KEY) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  try {
    const expected = await sign(payload, env);
    const actual = fromBase64Url(signature);
    if (expected.length !== actual.length) return null;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
    if (diff) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (session.exp < Math.floor(Date.now() / 1000) || !["guest", "admin"].includes(session.role)) return null;
    return session;
  } catch { return null; }
}

function json(value, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

function pcloudBase(env) {
  const base = env.PCLOUD_API_BASE || "https://eapi.pcloud.com";
  if (!/^https:\/\/(eapi|api)\.pcloud\.com$/.test(base)) throw new Error("PCLOUD_API_BASE muss auf eapi.pcloud.com oder api.pcloud.com zeigen.");
  return base;
}

async function pcloudJson(method, params, env) {
  if (!env.PCLOUD_ACCESS_TOKEN || !env.PCLOUD_FOLDER_ID) throw new Error("pCloud ist noch nicht konfiguriert.");
  const url = new URL(`${pcloudBase(env)}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.PCLOUD_ACCESS_TOKEN}` } });
  if (!response.ok) throw new Error(`pCloud ${method} antwortete mit HTTP ${response.status}.`);
  const data = await response.json();
  if (data.result !== 0) throw new Error(`pCloud ${method} meldet Fehler ${data.result}.`);
  return data;
}

function isImage(file) {
  const type = String(file.contenttype || "").toLowerCase();
  const extension = String(file.name || "").split(".").pop()?.toLowerCase();
  return type.startsWith("image/") && IMAGE_EXTENSIONS.has(extension);
}

async function listGallery(env) {
  const data = await pcloudJson("listfolder", { folderid: env.PCLOUD_FOLDER_ID }, env);
  const contents = data.metadata?.contents || [];
  const images = contents.filter(file => !file.isfolder && isImage(file)).map(file => ({
    id: String(file.fileid),
    name: String(file.name || "Photo"),
    size: Number(file.size || 0),
    created: file.created || file.modified || null,
    type: file.contenttype || "image/jpeg"
  })).sort((a, b) => (Date.parse(b.created || "") || 0) - (Date.parse(a.created || "") || 0) || b.id.localeCompare(a.id));
  return json({ images, appName: env.APP_NAME || "Wedding Photo Gallery" }, 200, { "Cache-Control": "private, no-store" });
}

async function uploadImages(request, env) {
  if (!env.PCLOUD_ACCESS_TOKEN || !env.PCLOUD_FOLDER_ID) throw new Error("pCloud ist noch nicht konfiguriert.");
  if (!request.body) return json({ error: "Keine Dateien empfangen." }, 400);
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) return json({ error: "Bitte Bilder als multipart/form-data hochladen." }, 415);
  const url = new URL(`${pcloudBase(env)}/uploadfile`);
  url.searchParams.set("folderid", env.PCLOUD_FOLDER_ID);
  url.searchParams.set("nopartial", "1");
  url.searchParams.set("renameifexists", "1");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PCLOUD_ACCESS_TOKEN}`, "Content-Type": contentType },
    body: request.body
  });
  if (!response.ok) throw new Error(`pCloud Upload antwortete mit HTTP ${response.status}.`);
  const data = await response.json();
  if (data.result !== 0) throw new Error(`pCloud Upload meldet Fehler ${data.result}.`);
  return json({ uploaded: data.metadata?.map(file => ({ id: String(file.fileid), name: String(file.name) })) || [], message: "Upload abgeschlossen." });
}

async function pcloudFileLink(method, params, env) {
  const data = await pcloudJson(method, params, env);
  const host = data.hosts?.[0];
  if (!host || !/^(?:[a-z0-9-]+\.)*pcloud\.com$/i.test(host) || !data.path?.startsWith("/")) throw new Error("pCloud hat keinen gültigen Dateilink geliefert.");
  return { url: `https://${host}${data.path}`, size: data.size };
}

async function serveImage(id, size, env) {
  if (!/^[0-9]{1,20}$/.test(id)) return json({ error: "Ungültige Bild-ID." }, 400);
  const variant = size === "original" ? "original" : size === "display" ? "display" : "thumb";
  const metadataResult = await pcloudJson("stat", { fileid: id }, env);
  const metadata = metadataResult.metadata;
  if (!metadata || !isImage(metadata)) return json({ error: "Bild nicht gefunden." }, 404);
  let link;
  let isThumbnail = false;
  let type = metadata.contenttype || "image/jpeg";
  if (variant !== "original" && metadata.thumb) {
    try {
      const thumbSize = variant === "display" ? "1600x1000" : "400x400";
      link = await pcloudFileLink("getthumblink", { fileid: id, size: thumbSize }, env);
      isThumbnail = true;
      type = "image/jpeg";
    } catch (error) {
      console.warn("pCloud thumbnail unavailable; using original", error instanceof Error ? error.message : "unknown error");
    }
  }
  if (!link) link = await pcloudFileLink("getfilelink", { fileid: id }, env);
  const upstream = await fetch(link.url);
  if (!upstream.ok || !upstream.body) throw new Error(`pCloud Bildantwort HTTP ${upstream.status}.`);
  if (variant !== "original" && env.IMAGES && (isThumbnail || Number(metadata.size || 0) <= 20 * 1024 * 1024)) {
    try {
      return (await env.IMAGES.input(upstream.body)
        .transform({ width: variant === "display" ? 1600 : 400, height: variant === "display" ? 1000 : 400, fit: "scale-down" })
        .output({ format: "image/webp", quality: 78, anim: true }))
        .response({ headers: { "Cache-Control": "private, max-age=3600", "Vary": "Cookie" } });
    } catch (error) {
      console.warn("Cloudflare image optimization fallback", error instanceof Error ? error.message : "unknown error");
      // Return the pCloud-generated JPEG thumbnail (or the original) if optimization is unavailable.
    }
  }
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, max-age=3600",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff"
  });
  if (variant === "original") headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(metadata.name || `photo-${id}`)}`);
  return new Response(upstream.body, { headers });
}

async function deleteImage(id, env) {
  const galleryData = await pcloudJson("listfolder", { folderid: env.PCLOUD_FOLDER_ID }, env);
  const inGallery = (galleryData.metadata?.contents || []).some(file => !file.isfolder && String(file.fileid) === id && isImage(file));
  if (!inGallery) return json({ error: "Dieses Bild liegt nicht direkt im Galerieordner." }, 404);
  const data = await pcloudJson("deletefile", { fileid: id }, env);
  return json({ deleted: true, fileid: id, result: data.result });
}
