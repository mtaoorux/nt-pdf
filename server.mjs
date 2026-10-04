import express from "express";
import cron from "node-cron";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { runSync } from "./sync.mjs";

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "data";
const SYNC_CRON = process.env.SYNC_CRON || "30 2 * * *"; // 02:30 UTC daily

let lastRun = null;
let running = false;

await mkdir(DATA_DIR, { recursive: true });

// ---- Cron schedule ---------------------------------------------------------
cron.schedule(SYNC_CRON, async () => {
  if (running) return console.log("Sync already running, skipping.");
  running = true;
  console.log(`[cron] Starting sync at ${new Date().toISOString()}`);
  try {
    lastRun = await runSync();
  } catch (e) {
    console.error("[cron] Sync failed:", e);
    lastRun = { error: e.message, finished_at: new Date().toISOString() };
  } finally {
    running = false;
  }
});

// ---- Routes ----------------------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "nt-pdf-archiver",
    status: "ok",
    schedule: SYNC_CRON,
    running,
    lastRun,
  });
});

app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/courses", async (_req, res) => {
  try {
    const files = await readdir(DATA_DIR).catch(() => []);
    const courses = [];
    for (const f of files) {
      if (!f.startsWith("course-") || !f.endsWith(".json")) continue;
      const id = Number(f.slice(7, -5));
      try {
        const arr = JSON.parse(await readFile(path.join(DATA_DIR, f), "utf8"));
        courses.push({
          course_id: id,
          count: arr.length,
          course_title: arr[0]?.course_title ?? null,
        });
      } catch {
        courses.push({ course_id: id, count: 0, error: "invalid json" });
      }
    }
    res.json({ courses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/courses/:id", async (req, res) => {
  const file = path.join(DATA_DIR, `course-${Number(req.params.id)}.json`);
  if (!existsSync(file)) return res.status(404).json({ error: "not found" });
  try {
    res.type("application/json").send(await readFile(file, "utf8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger — open, no auth
app.post("/sync", async (req, res) => {
  if (running) return res.status(409).json({ error: "sync already running" });
  running = true;
  try {
    lastRun = await runSync(
      req.query.course ? Number(req.query.course) : null
    );
    res.json(lastRun);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    running = false;
  }
});

app.listen(PORT, () => console.log(`Listening on :${PORT}`));
