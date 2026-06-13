#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");
const os = require("os");

const SITE_ORIGIN = "https://convert.freelrc.com";
const DECRYPT_URL = `${SITE_ORIGIN}/js/decrypt.js`;
const CACHE_DIR = path.join(__dirname, ".openyyy-cache");
const DECRYPT_JS = path.join(CACHE_DIR, "decrypt.js");
const IS_PACKAGED = Boolean(process.pkg);
const SOURCE_FORMAT_LABEL = "KGM/KGMA/NCM/KWM/MGG/MFLAC";
const DEFAULT_EXTS = new Set([
  ".kgm",
  ".kgma",
  ".ncm",
  ".kwm",
  ".mgg",
  ".mgg0",
  ".mgg1",
  ".mggl",
  ".mflac",
  ".mflac0",
]);
const WRAPPED_EXTS = new Set([".flac"]);
const KGM_MAGIC = Buffer.from("7CD532EB86027F4BA8AFA68E0FFF9914", "hex");
const ENCRYPTED_MAGIC = [
  { ext: ".kgm", test: (b) => b.length >= KGM_MAGIC.length && b.subarray(0, KGM_MAGIC.length).equals(KGM_MAGIC) },
  { ext: ".ncm", test: (b) => b.length >= 8 && b.toString("ascii", 0, 8) === "CTENFDAM" },
  { ext: ".kwm", test: (b) => b.length >= 11 && b.toString("ascii", 0, 11) === "yeelion-kuwo" },
];
const AUDIO_MAGIC = [
  { ext: ".mp3", test: (b) => b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
  { ext: ".mp3", test: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 },
  { ext: ".flac", test: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "fLaC" },
  { ext: ".ogg", test: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "OggS" },
  { ext: ".wav", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" },
];
const ALLOWED_AUDIO_BITRATES = new Set(["96", "128", "160", "192", "256", "320"]);
const ALLOWED_SAMPLE_RATES = new Set(["22050", "32000", "44100", "48000"]);
const ALLOWED_CHANNELS = new Set(["1", "2"]);

function parseArgs(argv) {
  const args = {
    root: __dirname,
    outDir: "",
    batchSize: 10,
    concurrency: 2,
    overwrite: false,
    dryRun: false,
    inProcess: false,
    includeExtensionless: false,
    fixExtensionlessMp3: false,
    refreshDecryptJs: false,
    audioBitrate: "",
    sampleRate: "",
    channels: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    if (arg === "--root") args.root = path.resolve(next());
    else if (arg === "--out-dir") args.outDir = path.resolve(next());
    else if (arg === "--batch-size") args.batchSize = Math.max(1, Number.parseInt(next(), 10) || 10);
    else if (arg === "--concurrency") args.concurrency = Math.max(1, Number.parseInt(next(), 10) || 1);
    else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--in-process") args.inProcess = true;
    else if (arg === "--include-extensionless") args.includeExtensionless = true;
    else if (arg === "--fix-extensionless-mp3") args.fixExtensionlessMp3 = true;
    else if (arg === "--refresh-decrypt-js") args.refreshDecryptJs = true;
    else if (arg === "--audio-bitrate") args.audioBitrate = next();
    else if (arg === "--sample-rate") args.sampleRate = next();
    else if (arg === "--channels") args.channels = next();
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node convert-kgm-to-mp3.js [options]

Converts ${SOURCE_FORMAT_LABEL} files under subfolders using OpenYYY's browser-side decrypt.js locally.
Non-MP3 decoded audio is transcoded to MP3 with ffmpeg when needed.

Options:
  --root <dir>                 Directory to scan. Default: script directory
  --out-dir <dir>              Output root. Preserves relative folders. Default: beside source files
  --batch-size <n>             Files loaded per batch. Default: 10
  --concurrency <n>            Parallel conversions. Default: 2
  --overwrite                  Replace existing output files
  --dry-run                    List planned work without writing files
  --in-process                 Convert in one Node process. Uses more memory; mainly for debugging
  --include-extensionless      Try extensionless encrypted files unless they already look like audio
  --fix-extensionless-mp3      Rename extensionless MP3-like files by appending .mp3
  --refresh-decrypt-js         Re-download the website decrypt script
  --audio-bitrate <kbps>       Re-encode MP3 with a bitrate such as 128, 192, 256, or 320
  --sample-rate <hz>           Re-encode MP3 with a sample rate such as 44100 or 48000
  --channels <n>               Re-encode MP3 with channel count 1 or 2
  --help                       Show this help
`);
}

async function ensureDecryptScript(refresh) {
  if (!refresh && fs.existsSync(DECRYPT_JS)) return;
  if (IS_PACKAGED && fs.existsSync(DECRYPT_JS)) return;
  if (IS_PACKAGED) {
    throw new Error("内置 decrypt.js 缺失，离线版无法重新下载解密脚本");
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[setup] downloading ${DECRYPT_URL}`);
  const res = await fetch(DECRYPT_URL);
  if (!res.ok) throw new Error(`Failed to download decrypt.js: HTTP ${res.status}`);
  fs.writeFileSync(DECRYPT_JS, Buffer.from(await res.arrayBuffer()));
}

function loadDecryptModule() {
  try {
    return require("./.openyyy-cache/decrypt.js");
  } catch {
    return require(DECRYPT_JS);
  }
}

function installBrowserPolyfills() {
  if (global.__openyyyPolyfillsInstalled) return;
  global.__openyyyPolyfillsInstalled = true;

  global.self = global;
  global.window = global;
  global.document = { currentScript: { src: DECRYPT_URL } };

  const originalConsoleLog = console.log.bind(console);
  console.log = (...args) => {
    const [first] = args;
    if (args.length === 1 && first && typeof first === "object" && first.blob && first.rawExt) return;
    originalConsoleLog(...args);
  };

  const originalFetch = global.fetch;
  global.fetch = (url, options) => {
    const finalUrl = typeof url === "string" && url.startsWith("/") ? `${SITE_ORIGIN}${url}` : url;
    return originalFetch(finalUrl, options);
  };

  if (typeof global.File === "undefined") {
    global.File = require("buffer").File;
  }

  global.FileReader = class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((arrayBuffer) => this.#finish(arrayBuffer))
        .catch((error) => this.#fail(error));
    }

    readAsDataURL(blob) {
      blob.arrayBuffer()
        .then((arrayBuffer) => {
          const data = Buffer.from(arrayBuffer).toString("base64");
          this.#finish(`data:${blob.type || ""};base64,${data}`);
        })
        .catch((error) => this.#fail(error));
    }

    #finish(result) {
      this.result = result;
      this.onload?.({ target: this });
      this.onloadend?.({ target: this });
    }

    #fail(error) {
      this.error = error;
      this.onerror?.({ target: this });
      this.onloadend?.({ target: this });
    }
  };
}

function walkFiles(root) {
  const files = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".openyyy-cache" || entry.name === "node_modules") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function detectAudioExt(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(16);
    const length = fs.readSync(fd, header, 0, header.length, 0);
    const sample = header.subarray(0, length);
    const match = AUDIO_MAGIC.find((item) => item.test(sample));
    return match ? match.ext : "";
  } finally {
    fs.closeSync(fd);
  }
}

function detectEncryptedExt(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const maxMagicLength = Math.max(...ENCRYPTED_MAGIC.map((item) => {
      if (item.ext === ".kgm") return KGM_MAGIC.length;
      if (item.ext === ".kwm") return 11;
      return 8;
    }));
    const header = Buffer.alloc(maxMagicLength);
    const length = fs.readSync(fd, header, 0, header.length, 0);
    const sample = header.subarray(0, length);
    const match = ENCRYPTED_MAGIC.find((item) => item.test(sample));
    if (match) return match.ext;
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

function sourceFileInfo(filePathOrName) {
  const originalName = path.basename(filePathOrName);
  const normalExt = path.extname(originalName).toLowerCase();
  if (DEFAULT_EXTS.has(normalExt)) {
    return {
      matched: true,
      baseName: path.parse(originalName).name,
      fileNameForDecrypt: originalName,
      sourceExt: normalExt,
      wrapperExt: "",
    };
  }

  if (WRAPPED_EXTS.has(normalExt)) {
    const unwrappedName = originalName.slice(0, -normalExt.length);
    const unwrappedExt = path.extname(unwrappedName).toLowerCase();
    if (DEFAULT_EXTS.has(unwrappedExt)) {
      return {
        matched: true,
        baseName: path.parse(unwrappedName).name,
        fileNameForDecrypt: unwrappedName,
        sourceExt: unwrappedExt,
        wrapperExt: normalExt,
      };
    }
  }

  return {
    matched: false,
    baseName: originalName,
    fileNameForDecrypt: originalName,
    sourceExt: normalExt,
    wrapperExt: "",
  };
}

function collectWork(args) {
  const files = walkFiles(args.root);
  const convert = [];
  const extensionlessAudio = [];
  const extensionlessEncrypted = [];

  for (const filePath of files) {
    const info = sourceFileInfo(filePath);
    if (info.matched) {
      convert.push(filePath);
      continue;
    }

    if (info.sourceExt === "") {
      const audioExt = detectAudioExt(filePath);
      if (audioExt) {
        extensionlessAudio.push({ filePath, audioExt });
        continue;
      }

      const encryptedExt = detectEncryptedExt(filePath);
      if (encryptedExt) {
        extensionlessEncrypted.push({ filePath, encryptedExt });
        if (args.includeExtensionless) convert.push(filePath);
      } else if (args.includeExtensionless) {
        convert.push(filePath);
      }
    }
  }

  return { convert, extensionlessAudio, extensionlessEncrypted };
}

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[ .]+$/g, "")
    .slice(0, 240) || "converted";
}

function normalizeAudioOptions(args) {
  const audioBitrate = String(args.audioBitrate || "").trim();
  const sampleRate = String(args.sampleRate || "").trim();
  const channels = String(args.channels || "").trim();

  if (audioBitrate && !ALLOWED_AUDIO_BITRATES.has(audioBitrate)) {
    throw new Error(`Unsupported audio bitrate: ${audioBitrate}`);
  }
  if (sampleRate && !ALLOWED_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`Unsupported sample rate: ${sampleRate}`);
  }
  if (channels && !ALLOWED_CHANNELS.has(channels)) {
    throw new Error(`Unsupported channel count: ${channels}`);
  }

  return { audioBitrate, sampleRate, channels };
}

function hasCustomAudioOptions(args) {
  const options = normalizeAudioOptions(args);
  return Boolean(options.audioBitrate || options.sampleRate || options.channels);
}

function baseNameWithoutSourceExt(inputPath, result) {
  const rawName = result.rawFilename || path.basename(inputPath);
  const info = sourceFileInfo(rawName);
  return info.matched ? info.baseName : rawName;
}

function outputPathFor(args, inputPath, result) {
  const fileName = `${sanitizeFileName(baseNameWithoutSourceExt(inputPath, result))}.mp3`;
  if (!args.outDir) return path.join(path.dirname(inputPath), fileName);
  const relativeDir = path.relative(args.root, path.dirname(inputPath));
  return path.join(args.outDir, relativeDir, fileName);
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(path.dirname(process.execPath), "ffmpeg.exe"),
    path.join(path.dirname(process.execPath), "bin", "ffmpeg.exe"),
    "ffmpeg",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const probe = childProcess.spawnSync(candidate, ["-version"], { encoding: "utf8", windowsHide: true });
      if (!probe.error && probe.status === 0) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

async function transcodeBufferToMp3(buffer, outputPath, args = {}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    throw new Error("ffmpeg not found; install ffmpeg or set FFMPEG_PATH to convert non-MP3 decoded audio to MP3");
  }
  const audioOptions = normalizeAudioOptions(args);

  const tempInput = path.join(os.tmpdir(), `openyyy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tempInput, buffer);

  try {
    const ffmpegArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      tempInput,
      "-vn",
      "-codec:a",
      "libmp3lame",
    ];

    if (audioOptions.audioBitrate) {
      ffmpegArgs.push("-b:a", `${audioOptions.audioBitrate}k`);
    } else {
      ffmpegArgs.push("-q:a", "2");
    }
    if (audioOptions.sampleRate) ffmpegArgs.push("-ar", audioOptions.sampleRate);
    if (audioOptions.channels) ffmpegArgs.push("-ac", audioOptions.channels);
    ffmpegArgs.push(outputPath);

    const result = childProcess.spawnSync(ffmpeg, ffmpegArgs, { encoding: "utf8", windowsHide: true });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `ffmpeg exited with code ${result.status}`).trim());
    }
  } finally {
    fs.rmSync(tempInput, { force: true });
  }
}

async function convertOne(decrypt, args, inputPath) {
  const originalName = path.basename(inputPath);
  const sourceInfo = sourceFileInfo(originalName);
  const detectedExt = sourceInfo.sourceExt ? "" : detectEncryptedExt(inputPath);
  const fileNameForDecrypt = sourceInfo.matched ? sourceInfo.fileNameForDecrypt : `${originalName}${detectedExt || ".kgm"}`;
  const data = fs.readFileSync(inputPath);
  const file = new File([data], fileNameForDecrypt);
  const result = await decrypt.Decrypt(file);
  const outputPath = outputPathFor(args, inputPath, result);

  if (fs.existsSync(outputPath) && !args.overwrite) {
    return { status: "skipped", inputPath, outputPath, reason: "output exists" };
  }

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const decoded = Buffer.from(await result.blob.arrayBuffer());
    if ((result.ext || "mp3").toLowerCase() === "mp3" && !hasCustomAudioOptions(args)) {
      fs.writeFileSync(outputPath, decoded);
    } else {
      await transcodeBufferToMp3(decoded, outputPath, args);
    }
  }

  return { status: args.dryRun ? "planned" : "converted", inputPath, outputPath, decodedExt: result.ext || "mp3" };
}

function fixExtensionlessMp3(items, dryRun) {
  let fixed = 0;
  for (const item of items) {
    if (item.audioExt !== ".mp3") continue;
    const target = `${item.filePath}.mp3`;
    if (fs.existsSync(target)) {
      console.log(`[skip] ${item.filePath} -> ${target} (target exists)`);
      continue;
    }
    console.log(`[rename] ${item.filePath} -> ${target}`);
    if (!dryRun) fs.renameSync(item.filePath, target);
    fixed += 1;
  }
  return fixed;
}

function fixExtensionlessEncrypted(items, dryRun) {
  let fixed = 0;
  for (const item of items) {
    const target = `${item.filePath}${item.encryptedExt}`;
    if (fs.existsSync(target)) {
      console.log(`[skip] ${item.filePath} -> ${target} (target exists)`);
      continue;
    }
    console.log(`[rename] ${item.filePath} -> ${target}`);
    if (!dryRun) fs.renameSync(item.filePath, target);
    fixed += 1;
  }
  return fixed;
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const results = [];
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runBatches(items, batchSize, concurrency, worker, onBatch) {
  const size = Math.max(1, batchSize || 10);
  const totalBatches = Math.ceil(items.length / size);
  const results = [];

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * size;
    const batch = items.slice(start, start + size);
    onBatch?.({ batchIndex, totalBatches, start, batchSize: batch.length });
    const batchResults = await runPool(batch, concurrency, async (item, localIndex) => {
      return worker(item, start + localIndex, { batchIndex, totalBatches, localIndex });
    });
    results.push(...batchResults);

    if (global.gc) global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }

  return results;
}

function readJsonLines(stream, onEvent) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        onEvent({ type: "worker-log", message: line });
      }
    }
  });
}

async function runIsolatedBatches(items, batchSize, concurrency, options, onEvent) {
  if (IS_PACKAGED) {
    await ensureDecryptScript(Boolean(options.refreshDecryptJs));
    installBrowserPolyfills();
    const decrypt = loadDecryptModule();
    const results = [];

    await runBatches(items, batchSize, concurrency, async (filePath, index) => {
      try {
        const result = await convertOne(decrypt, {
          root: options.root,
          outDir: options.outDir,
          overwrite: Boolean(options.overwrite),
          dryRun: false,
          audioBitrate: options.audioBitrate,
          sampleRate: options.sampleRate,
          channels: options.channels,
        }, filePath);
        results.push(result);
        onEvent?.({ type: "file", index, filePath, result });
      } catch (error) {
        onEvent?.({
          type: "file-error",
          index,
          filePath,
          error: error && error.stack ? error.stack : String(error),
        });
      }
    }, ({ batchIndex, totalBatches, start, batchSize: currentBatchSize }) => {
      onEvent?.({ type: "batch", batchIndex, totalBatches, start, batchSize: currentBatchSize });
    });

    return results;
  }

  const size = Math.max(1, batchSize || 10);
  const totalBatches = Math.ceil(items.length / size);
  const results = [];

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const start = batchIndex * size;
    const files = items.slice(start, start + size);
    onEvent?.({ type: "batch", batchIndex, totalBatches, start, batchSize: files.length });

    const jobPath = path.join(os.tmpdir(), `kgm-worker-${process.pid}-${Date.now()}-${batchIndex}.json`);
    fs.writeFileSync(jobPath, JSON.stringify({
      files,
      start,
      concurrency,
      root: options.root,
      outDir: options.outDir,
      overwrite: Boolean(options.overwrite),
      refreshDecryptJs: Boolean(options.refreshDecryptJs),
      audioBitrate: options.audioBitrate,
      sampleRate: options.sampleRate,
      channels: options.channels,
    }));

    await new Promise((resolve, reject) => {
      const childArgs = IS_PACKAGED
        ? ["--worker", jobPath]
        : [
        "--expose-gc",
        path.join(__dirname, "convert-batch-worker.js"),
        jobPath,
      ];

      const child = childProcess.spawn(process.execPath, childArgs, {
        cwd: IS_PACKAGED ? path.dirname(process.execPath) : __dirname,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      readJsonLines(child.stdout, (event) => {
        if (event.type === "file") results.push(event.result);
        onEvent?.(event);
      });

      child.stderr.on("data", (chunk) => {
        onEvent?.({ type: "worker-stderr", message: chunk.toString("utf8") });
      });

      child.on("error", reject);
      child.on("close", (code) => {
        fs.rmSync(jobPath, { force: true });
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }

  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { convert, extensionlessAudio, extensionlessEncrypted } = collectWork(args);

  console.log(`[scan] root: ${args.root}`);
  console.log(`[scan] ${SOURCE_FORMAT_LABEL} to convert: ${convert.length}`);
  console.log(`[scan] extensionless audio-like files: ${extensionlessAudio.length}`);
  console.log(`[scan] extensionless KGM-like files: ${extensionlessEncrypted.length}`);

  if (args.fixExtensionlessMp3) {
    const fixed = fixExtensionlessMp3(extensionlessAudio, args.dryRun);
    console.log(`[done] extensionless MP3 renamed: ${fixed}`);
  }

  if (args.includeExtensionless) {
    console.log("[scan] extensionless encrypted files will be converted with a detected or virtual extension");
  }

  if (convert.length === 0) return;
  if (args.dryRun) {
    for (const filePath of convert) console.log(`[plan] ${filePath}`);
    return;
  }

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  const handleResult = (filePath, currentIndex, result) => {
    const prefix = `[${currentIndex + 1}/${convert.length}]`;
    if (result.status === "converted") {
      converted += 1;
      console.log(`${prefix} converted: ${result.inputPath} -> ${result.outputPath}`);
    } else {
      skipped += 1;
      console.log(`${prefix} skipped: ${result.inputPath} (${result.reason})`);
    }
  };

  if (args.inProcess) {
    await ensureDecryptScript(args.refreshDecryptJs);
    installBrowserPolyfills();
    const decrypt = loadDecryptModule();
    await runBatches(convert, args.batchSize, args.concurrency, async (filePath, currentIndex) => {
      try {
        const result = await convertOne(decrypt, args, filePath);
        handleResult(filePath, currentIndex, result);
        return result;
      } catch (error) {
        failed += 1;
        console.error(`[${currentIndex + 1}/${convert.length}] failed: ${filePath}`);
        console.error(`  ${error && error.stack ? error.stack : error}`);
        return { status: "failed", inputPath: filePath, error };
      }
    }, ({ batchIndex, totalBatches, batchSize }) => {
      console.log(`[batch] ${batchIndex + 1}/${totalBatches}, files=${batchSize}`);
    });
  } else {
    await runIsolatedBatches(convert, args.batchSize, args.concurrency, args, (event) => {
      if (event.type === "batch") {
        console.log(`[batch] ${event.batchIndex + 1}/${event.totalBatches}, files=${event.batchSize}`);
      } else if (event.type === "file") {
        handleResult(event.filePath, event.index, event.result);
      } else if (event.type === "file-error") {
        failed += 1;
        console.error(`[${event.index + 1}/${convert.length}] failed: ${event.filePath}`);
        console.error(`  ${event.error}`);
      } else if (event.type === "fatal") {
        failed += 1;
        console.error(event.error);
      } else if (event.type === "worker-stderr") {
        process.stderr.write(event.message);
      }
    });
  }

  console.log(`[done] converted=${converted} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

module.exports = {
  collectWork,
  convertOne,
  detectAudioExt,
  detectEncryptedExt,
  ensureDecryptScript,
  fixExtensionlessEncrypted,
  fixExtensionlessMp3,
  installBrowserPolyfills,
  loadDecryptModule,
  outputPathFor,
  runBatches,
  runIsolatedBatches,
  runPool,
  sourceFileInfo,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
