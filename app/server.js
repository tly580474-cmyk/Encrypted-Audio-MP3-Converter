"use strict";

const EventEmitter = require("events");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const url = require("url");

const converter = require("../convert-kgm-to-mp3.js");

if (process.argv[2] === "--worker") {
  require("../convert-batch-worker.js");
  return;
}

const ROOT_DIR = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_OUT_DIR = path.join(ROOT_DIR, "mp3-output");
const PORT = Number.parseInt(process.env.PORT || "4317", 10);
const SOURCE_FORMAT_LABEL = "KGM/KGMA/NCM/KWM/MGG/MFLAC";

const jobs = new Map();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType(resolved) });
    res.end(data);
  });
}

function normalizeOptions(body) {
  const root = path.resolve(body.root || ROOT_DIR);
  const outDir = path.resolve(body.outDir || DEFAULT_OUT_DIR);
  return {
    root,
    outDir,
    batchSize: Math.max(1, Math.min(100, Number.parseInt(body.batchSize || "10", 10) || 10)),
    concurrency: Math.max(1, Math.min(8, Number.parseInt(body.concurrency || "2", 10) || 2)),
    overwrite: Boolean(body.overwrite),
    autoComplete: body.autoComplete !== false,
    refreshDecryptJs: Boolean(body.refreshDecryptJs),
  };
}

function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function pickFolder(startPath) {
  return new Promise((resolve, reject) => {
    const selectedPath = startPath && fs.existsSync(startPath) ? startPath : ROOT_DIR;
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = '选择文件夹'
      $dialog.SelectedPath = ${JSON.stringify(selectedPath)}
      $dialog.ShowNewFolderButton = $true
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dialog.SelectedPath
      }
    `;
    childProcess.execFile("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(script),
    ], { encoding: "utf8", windowsHide: false }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function scanDirectory(options) {
  const scan = converter.collectWork({
    root: options.root,
    includeExtensionless: false,
  });

  const alreadyConverted = scan.convert.filter((filePath) => {
    const expected = converter.outputPathFor(options, filePath, {});
    return fs.existsSync(expected);
  }).length;

  return {
    root: options.root,
    outDir: options.outDir,
    encrypted: scan.convert.length,
    kgm: scan.convert.length,
    extensionlessEncrypted: scan.extensionlessEncrypted.length,
    extensionlessKgm: scan.extensionlessEncrypted.length,
    extensionlessAudio: scan.extensionlessAudio.length,
    alreadyConverted,
    totalConvertible: scan.convert.length + (options.autoComplete ? scan.extensionlessEncrypted.length : 0),
    extensionlessKgmFiles: scan.extensionlessEncrypted.slice(0, 30).map((item) => item.filePath),
    extensionlessAudioFiles: scan.extensionlessAudio.slice(0, 30).map((item) => item.filePath),
  };
}

function createJob(options) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const emitter = new EventEmitter();
  const job = {
    id,
    options,
    emitter,
    state: {
      status: "queued",
      converted: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      logs: [],
      outputs: [],
      startedAt: Date.now(),
      finishedAt: null,
    },
  };
  jobs.set(id, job);
  runJob(job);
  return job;
}

function emitJob(job, type, payload) {
  const event = { type, payload, at: new Date().toISOString() };
  if (type === "log") {
    job.state.logs.push(payload);
    if (job.state.logs.length > 500) job.state.logs.shift();
  }
  job.emitter.emit("event", event);
}

async function runJob(job) {
  const options = job.options;
  job.state.status = "running";
  emitJob(job, "state", job.state);

  try {
    let scan = converter.collectWork({ root: options.root, includeExtensionless: false });
    emitJob(job, "log", `扫描完成：${scan.convert.length} 个 ${SOURCE_FORMAT_LABEL}，${scan.extensionlessEncrypted.length} 个缺少加密格式后缀，${scan.extensionlessAudio.length} 个缺少音频后缀。`);

    if (options.autoComplete) {
      const fixedMp3 = converter.fixExtensionlessMp3(scan.extensionlessAudio, false);
      const fixedKgm = converter.fixExtensionlessEncrypted(scan.extensionlessEncrypted, false);
      emitJob(job, "log", `自动补全：${fixedKgm} 个加密格式后缀，${fixedMp3} 个 .mp3。`);
      scan = converter.collectWork({ root: options.root, includeExtensionless: false });
    }

    const files = scan.convert;
    job.state.total = files.length;
    emitJob(job, "state", job.state);

    if (files.length === 0) {
      job.state.status = "done";
      job.state.finishedAt = Date.now();
      emitJob(job, "log", `没有需要转换的 ${SOURCE_FORMAT_LABEL} 文件。`);
      emitJob(job, "done", job.state);
      return;
    }

    await converter.runIsolatedBatches(files, options.batchSize, options.concurrency, options, (event) => {
      if (event.type === "batch") {
        emitJob(job, "log", `开始第 ${event.batchIndex + 1}/${event.totalBatches} 批，本批 ${event.batchSize} 个文件。`);
        return;
      }

      if (event.type === "file") {
        const result = event.result;
        if (result.status === "converted") {
          job.state.converted += 1;
          job.state.outputs.push(result.outputPath);
          const decoded = result.decodedExt && result.decodedExt !== "mp3" ? `（由 ${result.decodedExt.toUpperCase()} 转 MP3）` : "";
          emitJob(job, "log", `[${event.index + 1}/${files.length}] 已转换：${path.basename(result.outputPath)}${decoded}`);
        } else {
          job.state.skipped += 1;
          emitJob(job, "log", `[${event.index + 1}/${files.length}] 跳过：${path.basename(event.filePath)}，${result.reason}`);
        }
        emitJob(job, "state", job.state);
        return;
      }

      if (event.type === "file-error") {
        job.state.failed += 1;
        emitJob(job, "log", `[${event.index + 1}/${files.length}] 失败：${event.filePath}；${event.error}`);
        emitJob(job, "state", job.state);
        return;
      }

      if (event.type === "fatal") {
        job.state.failed += 1;
        emitJob(job, "log", `批处理进程失败：${event.error}`);
        emitJob(job, "state", job.state);
        return;
      }

      if (event.type === "worker-stderr") {
        emitJob(job, "log", event.message.trim());
      }
    });

    job.state.status = job.state.failed > 0 ? "completed-with-errors" : "done";
    job.state.finishedAt = Date.now();
    emitJob(job, "done", job.state);
  } catch (error) {
    job.state.status = "failed";
    job.state.finishedAt = Date.now();
    emitJob(job, "log", `任务失败：${error.stack || error.message || error}`);
    emitJob(job, "done", job.state);
  }
}

function handleEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404);
    res.end("Job not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  };

  send({ type: "state", payload: job.state });
  const listener = (event) => send(event);
  job.emitter.on("event", listener);

  req.on("close", () => {
    job.emitter.off("event", listener);
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (req.method === "GET" && pathname === "/api/defaults") {
      sendJson(res, 200, {
        root: ROOT_DIR,
        outDir: DEFAULT_OUT_DIR,
        batchSize: 10,
        concurrency: 2,
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/scan") {
      const options = normalizeOptions(await readJson(req));
      if (!fs.existsSync(options.root)) throw new Error(`路径不存在：${options.root}`);
      sendJson(res, 200, scanDirectory(options));
      return;
    }

    if (req.method === "POST" && pathname === "/api/pick-folder") {
      const body = await readJson(req);
      const folder = await pickFolder(body.currentPath || ROOT_DIR);
      sendJson(res, 200, { folder });
      return;
    }

    if (req.method === "POST" && pathname === "/api/convert") {
      const options = normalizeOptions(await readJson(req));
      if (!fs.existsSync(options.root)) throw new Error(`路径不存在：${options.root}`);
      const job = createJob(options);
      sendJson(res, 200, { jobId: job.id });
      return;
    }

    const eventMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventMatch) {
      handleEvents(req, res, eventMatch[1]);
      return;
    }

    const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "Job not found" });
        return;
      }
      sendJson(res, 200, job.state);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message || String(error) });
  }
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname.startsWith("/api/")) {
    handleApi(req, res, parsed.pathname);
    return;
  }
  serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  const appUrl = `http://127.0.0.1:${PORT}`;
  console.log(`KGM MP3 Converter app running at ${appUrl}`);
  if (process.pkg || process.env.OPEN_BROWSER === "1") {
    childProcess.spawn("cmd", ["/c", "start", "", appUrl], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  }
});
