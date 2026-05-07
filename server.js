import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Directories
const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, "ref-" + Date.now() + ext);
  },
});
const upload = multer({ storage, fileFilter: (req, file, cb) => {
  const allowed = [".png", ".jpg", ".jpeg", ".webp"];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowed.includes(ext));
}});

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Serve generated images and models
app.use("/api/images", express.static(OUTPUT_DIR));
app.use("/api/uploads", express.static(UPLOAD_DIR));

// ============================================================
// Upload individual view images (manual upload flow)
// ============================================================

// POST /api/upload-front
app.post("/api/upload-front", upload.single("image"), (req, res) => {
  try {
    console.log("\n[API] POST /api/upload-front");
    if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
    const timestamp = Date.now();
    const frontName = timestamp + "-front.png";
    fs.copyFileSync(req.file.path, path.join(OUTPUT_DIR, frontName));
    console.log("[Upload] Front image saved as:", frontName);
    res.json({ image: frontName });
  } catch (err) {
    console.error("[Upload] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upload-view
app.post("/api/upload-view", upload.single("image"), (req, res) => {
  try {
    console.log("\n[API] POST /api/upload-view");
    if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
    const view = req.body.view;
    if (!["back", "left", "right"].includes(view)) {
      return res.status(400).json({ error: "Invalid view. Must be: back, left, or right" });
    }
    const timestamp = Date.now();
    const fileName = timestamp + "-" + view + ".png";
    fs.copyFileSync(req.file.path, path.join(OUTPUT_DIR, fileName));
    console.log("[Upload] " + view + " view saved as:", fileName);
    res.json({ image: fileName });
  } catch (err) {
    console.error("[Upload] ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// OpenAI Image Generation
// ============================================================

const OPENAI_API_BASE = "https://api.openai.com/v1";

async function openaiEditImage(apiKey, prompt, imagePath, opts = {}) {
  const model = opts.model || "gpt-image-1.5";
  const size = opts.size || "1024x1024";
  const quality = opts.quality || "high";

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  form.append("size", size);
  form.append("quality", quality);
  form.append("output_format", "png");

  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const mime = mimes[ext] || "image/png";
  form.append("image", new Blob([buf], { type: mime }), path.basename(imagePath));

  const r = await fetch(OPENAI_API_BASE + "/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form,
  });

  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || "OpenAI API error: HTTP " + r.status);
  }

  const data = await r.json();
  return Buffer.from(data.data[0].b64_json, "base64");
}

// POST /api/generate-views
app.post("/api/generate-views", upload.single("image"), async (req, res) => {
  try {
    console.log("\n[API] POST /api/generate-views");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    if (!req.file) return res.status(400).json({ error: "No image file uploaded" });
    console.log("[OpenAI] Reference image:", req.file.originalname, "(" + (req.file.size / 1024).toFixed(1) + " KB)");

    const refPath = req.file.path;
    const timestamp = Date.now();

    const frontName = timestamp + "-front.png";
    fs.copyFileSync(refPath, path.join(OUTPUT_DIR, frontName));

    const views = [
      { name: "back", prompt: "Show this exact object from the back view. Same object, same style, rotated 180 degrees." },
      { name: "left", prompt: "Show this exact object from the left side view. Same object, same style, rotated 90 degrees left." },
      { name: "right", prompt: "Show this exact object from the right side view. Same object, same style, rotated 90 degrees right." },
    ];

    const imageNames = [frontName];

    for (const view of views) {
      console.log("Generating " + view.name + " view...");
      const imgBuffer = await openaiEditImage(apiKey, view.prompt, refPath);
      const fileName = timestamp + "-" + view.name + ".png";
      fs.writeFileSync(path.join(OUTPUT_DIR, fileName), imgBuffer);
      imageNames.push(fileName);
      console.log("  Saved: " + fileName);
    }

    console.log("[OpenAI] All views generated:", imageNames);
    res.json({ images: imageNames });
  } catch (err) {
    console.error("[OpenAI] ERROR:", err.message);
    if (err.stack) console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HiTem3D 3D Model Generation
// ============================================================

const HITEM3D_BASE = "https://api.hitem3d.ai";
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ATTEMPTS = 360;

function jsonRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers,
    };
    const req = transport.request(opts, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: r.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(new Error("Non-JSON response (" + r.statusCode + "): " + raw.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipartPost(urlStr, token, fields, files) {
  return new Promise((resolve, reject) => {
    const boundary = "----HiTem3DBoundary" + Date.now();
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;

    const parts = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="' + key + '"\r\n\r\n' +
        value + "\r\n"
      );
    }

    const fileParts = [];
    for (const { fieldName, filePath } of files) {
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
      const mime = mimeTypes[ext] || "application/octet-stream";
      const fileData = fs.readFileSync(filePath);
      const header = Buffer.from(
        "--" + boundary + "\r\n" +
        'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + fileName + '"\r\n' +
        "Content-Type: " + mime + "\r\n\r\n"
      );
      fileParts.push({ header, fileData });
    }

    const textPart = Buffer.from(parts.join(""));
    const closingBoundary = Buffer.from("\r\n--" + boundary + "--\r\n");
    const bodyParts = [textPart];
    for (const fp of fileParts) {
      bodyParts.push(fp.header, fp.fileData, Buffer.from("\r\n"));
    }
    bodyParts.push(closingBoundary);
    const bodyBuffer = Buffer.concat(bodyParts);

    const opts = {
      method: "POST",
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": bodyBuffer.length,
      },
    };

    const req = transport.request(opts, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: r.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(new Error("Non-JSON response (" + r.statusCode + "): " + raw.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    req.write(bodyBuffer);
    req.end();
  });
}

function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const handleResponse = (r) => {
      if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
        return downloadFile(r.headers.location, destPath).then(resolve).catch(reject);
      }
      if (r.statusCode !== 200) return reject(new Error("Download failed: HTTP " + r.statusCode));
      const file = fs.createWriteStream(destPath);
      r.pipe(file);
      file.on("finish", () => { file.close(); resolve(destPath); });
      file.on("error", (err) => { fs.unlink(destPath, () => {}); reject(err); });
    };
    transport.get(urlStr, handleResponse).on("error", reject);
  });
}

async function hitem3dAuth() {
  const clientId = process.env.HITEM3D_CLIENT_ID;
  const clientSecret = process.env.HITEM3D_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("HiTem3D credentials not configured");

  console.log("[HiTem3D] Authenticating with client ID:", clientId.slice(0, 8) + "...");
  const credentials = Buffer.from(clientId + ":" + clientSecret).toString("base64");
  const result = await jsonRequest("POST", HITEM3D_BASE + "/open-api/v1/auth/token", {
    Authorization: "Basic " + credentials,
    "Content-Type": "application/json",
  }, JSON.stringify({}));

  console.log("[HiTem3D] Auth response (HTTP " + result.status + "):", JSON.stringify(result.data, null, 2));

  if (result.data.code !== 200 || !result.data.data?.accessToken) {
    throw new Error("HiTem3D auth failed: " + JSON.stringify(result.data));
  }
  console.log("[HiTem3D] Auth successful, token received.");
  return result.data.data.accessToken;
}

async function hitem3dCreateTask(token, imagePaths, viewKeys, opts = {}) {
  // Compute multi_images_bit: a 4-char bitmask string for front/back/left/right
  // e.g. ["front","left"] → "1010", ["front","back","left","right"] → "1111"
  const VIEW_ORDER = ["front", "back", "left", "right"];
  const multiImagesBit = VIEW_ORDER.map(v => viewKeys.includes(v) ? "1" : "0").join("");

  const fields = {
    request_type: opts.requestType || 3,
    model: opts.model || "hitem3dv2.0",
    resolution: opts.resolution || "1536",
    face: opts.face || 800000,
    format: opts.format || 1,
    multi_images_bit: multiImagesBit,
  };

  const files = imagePaths.map((fp) => ({ fieldName: "multi_images", filePath: fp }));

  console.log("[HiTem3D] Creating task with fields:", JSON.stringify(fields));
  console.log("[HiTem3D] Image files:", imagePaths.map(p => path.basename(p)));
  for (const fp of imagePaths) {
    const stat = fs.statSync(fp);
    console.log("[HiTem3D]   " + path.basename(fp) + " - " + (stat.size / 1024).toFixed(1) + " KB");
  }

  const result = await multipartPost(HITEM3D_BASE + "/open-api/v1/submit-task", token, fields, files);
  console.log("[HiTem3D] Submit response (HTTP " + result.status + "):", JSON.stringify(result.data, null, 2));

  if (result.data.code !== 200 || !result.data.data?.task_id) {
    throw new Error("Task creation failed: " + JSON.stringify(result.data));
  }
  console.log("[HiTem3D] Task created: " + result.data.data.task_id);
  return result.data.data.task_id;
}

async function hitem3dPoll(token, taskId) {
  console.log("[HiTem3D] Polling task: " + taskId);
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const result = await jsonRequest("GET",
      HITEM3D_BASE + "/open-api/v1/query-task?task_id=" + encodeURIComponent(taskId),
      { Authorization: "Bearer " + token, "Content-Type": "application/json" }
    );
    const state = result.data.data?.state;
    const progress = result.data.data?.progress;
    console.log("[HiTem3D] Poll #" + attempt + " - state: " + state + (progress !== undefined ? ", progress: " + progress : ""));

    if (state === "success") {
      console.log("[HiTem3D] Task completed! Result:", JSON.stringify(result.data.data, null, 2));
      return result.data.data;
    }
    if (state === "failed") {
      console.error("[HiTem3D] Task FAILED. Full response:", JSON.stringify(result.data, null, 2));
      throw new Error("HiTem3D task failed: " + JSON.stringify(result.data));
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("HiTem3D task timed out after " + MAX_POLL_ATTEMPTS + " attempts");
}

// POST /api/generate-model
const FORMAT_EXT = { 1: "obj", 2: "glb", 3: "stl", 4: "fbx" };

app.post("/api/generate-model", async (req, res) => {
  try {
    console.log("\n[API] POST /api/generate-model");
    console.log("[API] Request body:", JSON.stringify(req.body));
    const { images, views, settings } = req.body;
    if (!images || images.length < 2 || !views || views.length !== images.length) {
      return res.status(400).json({ error: "At least 2 images with matching view labels required (e.g. front + one other)" });
    }
    if (!views.includes("front")) {
      return res.status(400).json({ error: "Front view is required" });
    }

    const imagePaths = images.map((name) => path.join(OUTPUT_DIR, name));
    for (const p of imagePaths) {
      if (!fs.existsSync(p)) return res.status(400).json({ error: "Image not found: " + path.basename(p) });
    }

    const opts = {};
    if (settings) {
      if (settings.face) opts.face = Number(settings.face);
      if (settings.format) opts.format = Number(settings.format);
      if (settings.resolution) opts.resolution = String(settings.resolution);
      if (settings.model) opts.model = settings.model;
      if (settings.requestType) opts.requestType = Number(settings.requestType);
    }

    console.log("Authenticating with HiTem3D...");
    const token = await hitem3dAuth();

    console.log("Creating 3D generation task...");
    console.log("[HiTem3D] Views provided:", views);
    const taskId = await hitem3dCreateTask(token, imagePaths, views, opts);

    console.log("Polling for completion (task: " + taskId + ")...");
    const taskData = await hitem3dPoll(token, taskId);

    const formatNum = opts.format || 1;
    const ext = FORMAT_EXT[formatNum] || "obj";

    const results = {};
    if (taskData.url) {
      const modelFile = path.join(OUTPUT_DIR, taskId + "." + ext);
      await downloadFile(taskData.url, modelFile);
      results.model = taskId + "." + ext;
      console.log("Model saved: " + modelFile);
    }
    if (taskData.cover_url) {
      const previewFile = path.join(OUTPUT_DIR, taskId + "_preview.png");
      await downloadFile(taskData.cover_url, previewFile);
      results.preview = taskId + "_preview.png";
    }

    console.log("[HiTem3D] Done! Results:", JSON.stringify(results));
    res.json(results);
  } catch (err) {
    console.error("[HiTem3D] ERROR:", err.message);
    if (err.stack) console.error(err.stack);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status
app.get("/api/status", (req, res) => {
  res.json({
    openai: !!process.env.OPENAI_API_KEY,
    hitem3d: !!(process.env.HITEM3D_CLIENT_ID && process.env.HITEM3D_CLIENT_SECRET),
  });
});

app.listen(PORT, () => {
  console.log("\n  3D Model Creator running at http://localhost:" + PORT + "\n");
});
