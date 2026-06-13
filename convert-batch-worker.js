"use strict";

const fs = require("fs");
const path = require("path");
const converter = require("./convert-kgm-to-mp3.js");

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  const jobPath = process.argv[2] === "--worker" ? process.argv[3] : process.argv[2];
  if (!jobPath) throw new Error("Missing worker job file path");

  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  await converter.ensureDecryptScript(Boolean(job.refreshDecryptJs));
  converter.installBrowserPolyfills();
  const decrypt = converter.loadDecryptModule();

  await converter.runPool(job.files, job.concurrency, async (filePath, localIndex) => {
    const index = job.start + localIndex;
    try {
      const result = await converter.convertOne(decrypt, {
        root: job.root,
        outDir: job.outDir,
        overwrite: job.overwrite,
        dryRun: false,
        audioBitrate: job.audioBitrate,
        sampleRate: job.sampleRate,
        channels: job.channels,
      }, filePath);
      writeEvent({ type: "file", index, filePath, result });
    } catch (error) {
      writeEvent({
        type: "file-error",
        index,
        filePath,
        error: error && error.stack ? error.stack : String(error),
      });
    }
  });

  if (global.gc) global.gc();
}

main().catch((error) => {
  writeEvent({ type: "fatal", error: error && error.stack ? error.stack : String(error) });
  process.exit(1);
});
