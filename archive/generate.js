import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";

const DEFAULTS = {
  model: "gpt-image-1.5",
  size: "1024x1024",
  quality: "high",
  thinking: "off",
  outputFormat: "png",
  outputDir: "./output",
};

const API_BASE = "https://api.openai.com/v1";

function parseArgs() {
  const args = process.argv.slice(2);
  const p = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--prompt": case "-p": p.prompt = args[++i]; break;
      case "--image": case "-i": p.image = args[++i]; break;
      case "--output": case "-o": p.output = args[++i]; break;
      case "--size": case "-s": p.size = args[++i]; break;
      case "--quality": case "-q": p.quality = args[++i]; break;
      case "--model": case "-m": p.model = args[++i]; break;
      case "--name": case "-n": p.name = args[++i]; break;
      case "--thinking": case "-t": p.thinking = args[++i]; break;
      case "--views": case "-v": p.views = true; break;
      case "--help": case "-h": printHelp(); process.exit(0);
      default: if (!p.prompt) p.prompt = args[i];
    }
  }
  return p;
}

function printHelp() {
  console.log([
    "",
    "  OpenAI Image Generator",
    "",
    "  Usage:",
    "    node generate.js [options]",
    '    node generate.js "a sunset over mountains"',
    "",
    "  Options:",
    "    -p, --prompt <text>     The image generation prompt",
    "    -i, --image  <path>     Path to a reference image (uses edit endpoint)",
    "    -o, --output <dir>      Output directory (default: ./output)",
    "    -n, --name   <name>     Output filename without extension",
    "    -s, --size   <size>     1024x1024, 1536x1024, 2048x2048, auto",
    "    -q, --quality <level>   low, medium, high, auto",
    "    -t, --thinking <level>  off, low, medium, high (default: off)",
    "    -v, --views             Generate back, left, right views from a reference image",
    "    -m, --model  <model>    Model name (default: gpt-image-1.5)",
    "    -h, --help              Show this help message",
    "",
    "  Note: gpt-image-2 does NOT support transparent backgrounds.",
    "        Use --model gpt-image-1 if you need transparency.",
    "",
  ].join("\n"));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function gatherInteractive(cli) {
  const c = { ...cli };
  if (!c.prompt) {
    c.prompt = await ask("Enter your image prompt: ");
    if (!c.prompt) { console.error("Error: A prompt is required."); process.exit(1); }
  }
  if (c.image === undefined) {
    const img = await ask("Path to a reference image (leave blank to skip): ");
    if (img) c.image = img;
  }
  if (!c.name) {
    const n = await ask("Output filename without extension (leave blank for timestamp): ");
    if (n) c.name = n;
  }
  return c;
}

async function apiGenerate(apiKey, params) {
  const res = await fetch(API_BASE + "/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(body.error?.message || "HTTP " + res.status);
    e.status = res.status; e.error = body.error; throw e;
  }
  return res.json();
}

async function apiEdit(apiKey, params, imgPath) {
  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", params.prompt);
  form.append("n", String(params.n));
  form.append("size", params.size);
  if (params.quality) form.append("quality", params.quality);
  if (params.thinking) form.append("thinking", params.thinking);
  if (params.output_format) form.append("output_format", params.output_format);
  const buf = fs.readFileSync(imgPath);
  const ext = path.extname(imgPath).toLowerCase();
  const mimes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const mime = mimes[ext] || "image/png";
  form.append("image", new Blob([buf], { type: mime }), path.basename(imgPath));
  const res = await fetch(API_BASE + "/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(body.error?.message || "HTTP " + res.status);
    e.status = res.status; e.error = body.error; throw e;
  }
  return res.json();
}

async function generateImage(config) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = config.model || DEFAULTS.model;
  const size = config.size || DEFAULTS.size;
  const quality = config.quality || DEFAULTS.quality;
  const thinking = config.thinking || DEFAULTS.thinking;
  const outDir = config.output || DEFAULTS.outputDir;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  let b64;
  if (config.image) {
    const imgPath = path.resolve(config.image);
    if (!fs.existsSync(imgPath)) { console.error("Error: Image file not found: " + imgPath); process.exit(1); }
    console.log("\nModel:     " + model);
    console.log("Mode:      Edit (with reference image)");
    console.log("Image:     " + imgPath);
    console.log("Prompt:    " + config.prompt);
    console.log("Size:      " + size);
    console.log("Quality:   " + quality);
    console.log("Thinking:  " + thinking);
    console.log("Generating...\n");
    const p = { model, prompt: config.prompt, n: 1, size, quality, output_format: DEFAULTS.outputFormat };
    if (thinking !== "off") p.thinking = thinking;
    const r = await apiEdit(apiKey, p, imgPath);
    b64 = r.data[0].b64_json;
  } else {
    console.log("\nModel:     " + model);
    console.log("Mode:      Generate (text-to-image)");
    console.log("Prompt:    " + config.prompt);
    console.log("Size:      " + size);
    console.log("Quality:   " + quality);
    console.log("Thinking:  " + thinking);
    console.log("Generating...\n");
    const p = { model, prompt: config.prompt, n: 1, size, quality, output_format: DEFAULTS.outputFormat };
    if (thinking !== "off") p.thinking = thinking;
    const r = await apiGenerate(apiKey, p);
    b64 = r.data[0].b64_json;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = (config.name || ts) + ".png";
  const outPath = path.join(outDir, fname);
  fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log("Image saved to: " + outPath);
  return outPath;
}

async function generateViews(config) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = config.model || DEFAULTS.model;
  const size = config.size || DEFAULTS.size;
  const quality = config.quality || DEFAULTS.quality;
  const thinking = config.thinking || DEFAULTS.thinking;
  const outDir = config.output || DEFAULTS.outputDir;
  const imgPath = path.resolve(config.image);
  if (!fs.existsSync(imgPath)) { console.error("Error: Image file not found: " + imgPath); process.exit(1); }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const views = [
    { name: "back", prompt: "Show this image from the back" },
    { name: "left", prompt: "Show this image from the left" },
    { name: "right", prompt: "Show this image from the right" },
  ];
  for (const view of views) {
    console.log("\n--- Generating " + view.name + " view ---");
    console.log("Model:     " + model);
    console.log("Image:     " + imgPath);
    console.log("Prompt:    " + view.prompt);
    console.log("Generating...\n");
    const p = { model, prompt: view.prompt, n: 1, size, quality, output_format: DEFAULTS.outputFormat };
    if (thinking !== "off") p.thinking = thinking;
    const r = await apiEdit(apiKey, p, imgPath);
    const outPath = path.join(outDir, view.name + ".png");
    fs.writeFileSync(outPath, Buffer.from(r.data[0].b64_json, "base64"));
    console.log("Saved: " + outPath);
  }
  console.log("\nAll 3 views saved to " + outDir);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY not found. Create a .env file with your key.");
    process.exit(1);
  }
  const cli = parseArgs();
  if (cli.views) {
    if (!cli.image) {
      console.error("Error: --views requires --image <path> to a reference image.");
      process.exit(1);
    }
    try {
      await generateViews(cli);
    } catch (err) {
      console.error("\nAPI Error:", err.message);
      if (err.status) console.error("Status:", err.status);
      if (err.error) console.error("Details:", JSON.stringify(err.error, null, 2));
      process.exit(1);
    }
    return;
  }
  const config = await gatherInteractive(cli);
  try {
    await generateImage(config);
  } catch (err) {
    console.error("\nAPI Error:", err.message);
    if (err.status) console.error("Status:", err.status);
    if (err.error) console.error("Details:", JSON.stringify(err.error, null, 2));
    process.exit(1);
  }
}

main();
