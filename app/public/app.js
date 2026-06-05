"use strict";

const els = {
  appStatus: document.getElementById("appStatus"),
  autoCompleteInput: document.getElementById("autoCompleteInput"),
  batchSizeInput: document.getElementById("batchSizeInput"),
  clearLogButton: document.getElementById("clearLogButton"),
  clearOutputButton: document.getElementById("clearOutputButton"),
  concurrencyInput: document.getElementById("concurrencyInput"),
  convertButton: document.getElementById("convertButton"),
  convertedCount: document.getElementById("convertedCount"),
  existingCount: document.getElementById("existingCount"),
  kgmCount: document.getElementById("kgmCount"),
  logBox: document.getElementById("logBox"),
  missingKgmCount: document.getElementById("missingKgmCount"),
  missingMp3Count: document.getElementById("missingMp3Count"),
  outInput: document.getElementById("outInput"),
  outputList: document.getElementById("outputList"),
  overwriteInput: document.getElementById("overwriteInput"),
  pickOutButton: document.getElementById("pickOutButton"),
  pickRootButton: document.getElementById("pickRootButton"),
  progressBar: document.getElementById("progressBar"),
  progressText: document.getElementById("progressText"),
  refreshInput: document.getElementById("refreshInput"),
  rootInput: document.getElementById("rootInput"),
  scanButton: document.getElementById("scanButton"),
  totalCount: document.getElementById("totalCount"),
};

let activeEvents = null;

function setStatus(text, mode = "idle") {
  els.appStatus.textContent = text;
  els.appStatus.dataset.mode = mode;
}

function setBusy(isBusy) {
  els.scanButton.disabled = isBusy;
  els.convertButton.disabled = isBusy;
  els.rootInput.disabled = isBusy;
  els.outInput.disabled = isBusy;
}

function addLog(message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  els.logBox.appendChild(line);
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function addOutput(filePath) {
  const item = document.createElement("li");
  item.textContent = filePath;
  els.outputList.appendChild(item);
  els.outputList.scrollTop = els.outputList.scrollHeight;
}

function getOptions() {
  return {
    root: els.rootInput.value.trim(),
    outDir: els.outInput.value.trim(),
    batchSize: Number.parseInt(els.batchSizeInput.value, 10) || 20,
    concurrency: Number.parseInt(els.concurrencyInput.value, 10) || 2,
    autoComplete: els.autoCompleteInput.checked,
    overwrite: els.overwriteInput.checked,
    refreshDecryptJs: els.refreshInput.checked,
  };
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function pickFolder(input) {
  setStatus("选择目录", "running");
  try {
    const data = await api("/api/pick-folder", { currentPath: input.value.trim() });
    if (data.folder) {
      input.value = data.folder;
      addLog(`已选择目录：${data.folder}`);
    }
    setStatus("就绪", "idle");
  } catch (error) {
    addLog(`选择目录失败：${error.message}`);
    setStatus("选择失败", "error");
  }
}

function updateScan(scan) {
  const encrypted = scan.encrypted ?? scan.kgm;
  const extensionlessEncrypted = scan.extensionlessEncrypted ?? scan.extensionlessKgm;
  els.kgmCount.textContent = String(encrypted);
  els.missingKgmCount.textContent = String(extensionlessEncrypted);
  els.missingMp3Count.textContent = String(scan.extensionlessAudio);
  els.existingCount.textContent = String(scan.alreadyConverted);
  els.totalCount.textContent = String(scan.totalConvertible);
  els.convertedCount.textContent = "0";
  els.progressBar.style.width = "0%";
  els.progressText.textContent = `可转换 ${scan.totalConvertible} 个；输出到 ${scan.outDir}`;
}

function updateProgress(state) {
  const done = state.converted + state.skipped + state.failed;
  const total = state.total || 0;
  els.convertedCount.textContent = String(done);
  els.totalCount.textContent = String(total);
  els.progressBar.style.width = total ? `${Math.min(100, Math.round((done / total) * 100))}%` : "0%";
  els.progressText.textContent = `成功 ${state.converted}，跳过 ${state.skipped}，失败 ${state.failed}`;
}

async function loadDefaults() {
  const response = await fetch("/api/defaults");
  const defaults = await response.json();
  els.rootInput.value = defaults.root;
  els.outInput.value = defaults.outDir;
  els.batchSizeInput.value = defaults.batchSize;
  els.concurrencyInput.value = defaults.concurrency;
  addLog("应用已启动。");
}

async function scan() {
  setBusy(true);
  setStatus("扫描中", "running");
  try {
    const result = await api("/api/scan", getOptions());
    updateScan(result);
    const encrypted = result.encrypted ?? result.kgm;
    const extensionlessEncrypted = result.extensionlessEncrypted ?? result.extensionlessKgm;
    addLog(`扫描：${encrypted} 个加密音频，${extensionlessEncrypted} 个缺加密后缀，${result.extensionlessAudio} 个缺音频后缀。`);
    setStatus("扫描完成", "ok");
  } catch (error) {
    addLog(`扫描失败：${error.message}`);
    setStatus("扫描失败", "error");
  } finally {
    setBusy(false);
  }
}

async function convert() {
  if (activeEvents) activeEvents.close();
  els.outputList.innerHTML = "";
  setBusy(true);
  setStatus("转换中", "running");
  try {
    const { jobId } = await api("/api/convert", getOptions());
    addLog(`任务已创建：${jobId}`);
    activeEvents = new EventSource(`/api/jobs/${jobId}/events`);

    activeEvents.addEventListener("state", (event) => {
      updateProgress(JSON.parse(event.data));
    });

    activeEvents.addEventListener("log", (event) => {
      addLog(JSON.parse(event.data));
    });

    activeEvents.addEventListener("done", (event) => {
      const state = JSON.parse(event.data);
      updateProgress(state);
      state.outputs.slice(-80).forEach(addOutput);
      setStatus(state.failed > 0 ? "有失败" : "已完成", state.failed > 0 ? "error" : "ok");
      setBusy(false);
      activeEvents.close();
      activeEvents = null;
    });

    activeEvents.onerror = () => {
      addLog("实时日志连接中断。");
      setStatus("连接中断", "error");
      setBusy(false);
      activeEvents?.close();
      activeEvents = null;
    };
  } catch (error) {
    addLog(`转换失败：${error.message}`);
    setStatus("转换失败", "error");
    setBusy(false);
  }
}

els.scanButton.addEventListener("click", scan);
els.convertButton.addEventListener("click", convert);
els.pickRootButton.addEventListener("click", () => pickFolder(els.rootInput));
els.pickOutButton.addEventListener("click", () => pickFolder(els.outInput));
els.clearLogButton.addEventListener("click", () => {
  els.logBox.innerHTML = "";
});
els.clearOutputButton.addEventListener("click", () => {
  els.outputList.innerHTML = "";
});

loadDefaults().catch((error) => {
  addLog(`加载默认配置失败：${error.message}`);
  setStatus("异常", "error");
});
