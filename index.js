// =========================================================================
// Next Toppers PDF URL Archiver — single-file version (fixed).
// Crawls batches -> folder trees -> pdfurl endpoint.
// Stores PDF URLs in data/course-<id>.json (append-only, deduped).
// Runs a daily cron and exposes a small REST API.
// =========================================================================

import express from "express";
import cron from "node-cron";
import { readFile, writeFile, rename, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// -------------------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------------------
const BATCHES_URL = "https://mtaiirusapi.onrender.com/api/nt/batches";
const CONTENT_URL = "https://mtaiirusapi.onrender.com/api/nt/content";
const PDF_URL = "https://nexttoppers.nextmate.site/api/course/pdfurl";

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "data";
const SYNC_CRON = process.env.SYNC_CRON || "30 2 * * *"; // 02:30 UTC daily
const RUN_ON_START = process.env.RUN_ON_START === "1";
const SYNC_TOKEN = process.env.SYNC_TOKEN || ""; // optional: protects /sync
const ALL_FILE = path.join(DATA_DIR, "all-pdfs.json"); // every PDF URL, all courses

let lastRun = null;
let running = false;

console.log(`[config] DATA_DIR=${DATA_DIR} (resolved: ${path.resolve(DATA_DIR)})`);

// Never let a stray error kill the process.
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------
// FETCH HELPER (retries + timeout + JSON check)
// -------------------------------------------------------------------------
async function fetchJson(url, { retries = 4, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; nt-pdf-archiver/1.0)",
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // strip BOM + whitespace before checking
      const text = (await res.text()).replace(/^\uFEFF/, "").trim();
      clearTimeout(t);
      if (!text.startsWith("{") && !text.startsWith("[")) {
        throw new Error(`Non-JSON response: ${text.slice(0, 80)}`);
      }
      return JSON.parse(text);
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      console.warn(`[retry ${attempt}/${retries}] ${e.message} :: ${url}`);
      if (attempt < retries) await sleep(attempt * 3000);
    }
  }
  throw lastErr;
}

// Render free-tier services sleep; wait until the upstream really answers.
async function wakeUpstream(maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(BATCHES_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        console.log("[sync] Upstream is awake.");
        return true;
      }
    } catch {}
    console.log("[sync] Waiting for upstream to wake...");
    await sleep(5000);
  }
  console.warn("[sync] Upstream did not wake in time, trying anyway.");
  return false;
}

// -------------------------------------------------------------------------
// CRAWLER
// -------------------------------------------------------------------------
function collectBatches(categories, out) {
  for (const cat of categories ?? []) {
    for (const b of cat.batches ?? []) {
      out.push({ id: String(b.id), title: b.title, category: cat.category_name });
    }
    if (cat.sub_categories?.length) collectBatches(cat.sub_categories, out);
  }
}

async function listCourses() {
  console.log("[list] Fetching batches...");
  const json = await fetchJson(BATCHES_URL);
  const catalog = Array.isArray(json)
    ? json
    : json.catalog ?? json.data ?? [];
  const courses = [];
  collectBatches(catalog, courses);
  const seen = new Set();
  const unique = courses.filter((c) =>
    seen.has(c.id) ? false : (seen.add(c.id), true)
  );
  console.log(`[list] Found ${unique.length} course(s) (catalog len=${catalog.length})`);
  return unique;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        console.warn(`[mapLimit] ${e.message}`);
        results[idx] = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

async function crawlCourse(course, onBatch = null) {
  const entries = [];
  const queue = [{ folderId: "0", path: "" }];
  const visited = new Set();

  while (queue.length) {
    const batch = queue.splice(0, 8);
    const lists = await mapLimit(batch, 8, async ({ folderId, path: p }) => {
      if (visited.has(folderId)) return { path: p, items: [] };
      visited.add(folderId);
      try {
        const json = await fetchJson(
          `${CONTENT_URL}?course_id=${course.id}&folder_id=${folderId}`
        );
        const items = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json)
          ? json
          : [];
        return { path: p, items };
      } catch (e) {
        console.warn(`[content] course=${course.id} folder=${folderId}: ${e.message}`);
        return { path: p, items: [] };
      }
    });

    const pdfFolders = [];
    for (const res of lists) {
      if (!res) continue;
      const { path: p, items } = res;
      for (const item of items) {
        if (item.type !== "folder") continue;
        const childPath = p ? `${p} / ${item.title}` : item.title;
        const counts = item.data?.content_counts;
        const pdfCount =
          Number(counts?.pdf?.free ?? 0) + Number(counts?.pdf?.paid ?? 0);
        const subFolders = Number(counts?.folders?.total ?? 0);
        if (pdfCount > 0)
          pdfFolders.push({ folderId: String(item.entity_id), path: childPath });
        if (subFolders > 0)
          queue.push({ folderId: String(item.entity_id), path: childPath });
      }
    }

    const found = await mapLimit(pdfFolders, 6, async ({ folderId, path: p }) => {
      try {
        const json = await fetchJson(
          `${PDF_URL}?content_id=${folderId}&course_id=${course.id}`
        );
        if (!json.file_url) return null;
        return {
          course_id: course.id,
          course_title: course.title,
          folder_id: folderId,
          folder_path: p,
          title: json.title ?? "",
          file_url: json.file_url,
          found_at: new Date().toISOString(),
        };
      } catch (e) {
        console.warn(`[pdf] course=${course.id} folder=${folderId}: ${e.message}`);
        return null;
      }
    });
    const fresh = found.filter(Boolean);
    entries.push(...fresh);
    // Save to the JSON files right away, so nothing is lost if the crawl dies later.
    if (fresh.length && onBatch) {
      try {
        await onBatch(fresh);
      } catch (e) {
        console.error(`[save] course=${course.id}: ${e.message}`);
      }
    }
  }
  return entries;
}

const keyOf = (e) => `${e.course_id}:${e.folder_id}:${e.file_url}`;

async function appendJson(filePath, records) {
  let existing = [];
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      const backup = `${filePath}.bak-${Date.now()}`;
      try {
        await writeFile(backup, await readFile(filePath, "utf8"));
        console.warn(`Corrupt JSON backed up to ${backup}`);
      } catch {}
    }
  }
  const keys = new Set(existing.map(keyOf));
  const fresh = [];
  for (const r of records) {
    const k = keyOf(r);
    if (!keys.has(k)) {
      keys.add(k);
      fresh.push(r);
    }
  }
  const merged = [...existing, ...fresh];
  if (fresh.length) {
    await mkdir(path.dirname(filePath), { recursive: true });
    // atomic write: tmp file then rename
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(merged, null, 2));
    await rename(tmp, filePath);
    console.log(`[write] ${filePath} +${fresh.length} (total ${merged.length})`);
  } else {
    console.log(`[write] ${filePath} no new records (existing ${existing.length})`);
  }
  return { added: fresh.length, total: merged.length };
}

async function runSync(onlyCourseId = null) {
  console.log(`[sync] START ${new Date().toISOString()}`);
  await wakeUpstream();

  const courses = await listCourses();
  const targets = onlyCourseId
    ? courses.filter((c) => c.id === String(onlyCourseId))
    : courses;

  if (targets.length === 0) {
    console.warn("[sync] No courses to crawl. Upstream may be down or catalog empty.");
  }

  const summary = [];
  let addedTotal = 0;

  for (const course of targets) {
    try {
      console.log(`[course ${course.id}] crawling "${course.title}"`);
      const filePath = path.join(DATA_DIR, `course-${course.id}.json`);
      let added = 0;
      let total = 0;
      const entries = await crawlCourse(course, async (fresh) => {
        // 1) per-course file  2) combined file with every PDF URL
        const r = await appendJson(filePath, fresh);
        await appendJson(ALL_FILE, fresh);
        added += r.added;
        total = r.total;
      });
      if (total === 0 && existsSync(filePath)) {
        try {
          total = JSON.parse(await readFile(filePath, "utf8")).length;
        } catch {}
      }
      addedTotal += added;
      summary.push({
        course_id: course.id,
        course_title: course.title,
        found: entries.length,
        added,
        total,
      });
      console.log(
        `#${course.id} ${course.title}: ${entries.length} found, ${added} new, ${total} total`
      );
    } catch (err) {
      console.error(`#${course.id} ${course.title}: ERROR ${err.message}`);
      summary.push({
        course_id: course.id,
        course_title: course.title,
        error: err.message,
      });
    }
  }
  console.log(`[sync] DONE. ${addedTotal} new PDF URL(s) added.`);
  return { addedTotal, summary, finished_at: new Date().toISOString() };
}

// Single entry point with a lock, used by cron, startup and the API.
async function startSync(onlyCourseId = null) {
  if (running) return false;
  running = true;
  (async () => {
    try {
      lastRun = await runSync(onlyCourseId);
    } catch (e) {
      console.error("[sync] failed:", e);
      lastRun = { error: e.message, finished_at: new Date().toISOString() };
    } finally {
      running = false;
    }
  })();
  return true;
}

// -------------------------------------------------------------------------
// EXPRESS SERVER
// -------------------------------------------------------------------------
const app = express();

await mkdir(DATA_DIR, { recursive: true });

// Daily cron
cron.schedule(
  SYNC_CRON,
  async () => {
    console.log(`[cron] Triggered at ${new Date().toISOString()}`);
    if (!(await startSync())) console.log("[cron] Sync already running, skipping.");
  },
  { timezone: "UTC" }
);

// Status
app.get("/", (_req, res) => {
  res.json({
    service: "nt-pdf-archiver",
    status: "ok",
    schedule: SYNC_CRON,
    data_dir: DATA_DIR,
    running,
    lastRun,
  });
});

// Health check
app.get("/healthz", (_req, res) => res.send("ok"));

// List courses
app.get("/courses", async (_req, res) => {
  try {
    const files = await readdir(DATA_DIR).catch(() => []);
    const courses = [];
    for (const f of files) {
      if (!/^course-.+\.json$/.test(f)) continue;
      const id = f.slice(7, -5);
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
    res.json({ data_dir: DATA_DIR, courses });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One course's full PDF list
app.get("/courses/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^\w-]/g, "");
  const file = path.join(DATA_DIR, `course-${id}.json`);
  if (!existsSync(file)) return res.status(404).json({ error: "not found" });
  try {
    res.type("application/json").send(await readFile(file, "utf8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// All PDF URLs from every course in one JSON file
app.get("/all", async (_req, res) => {
  if (!existsSync(ALL_FILE)) return res.json([]);
  try {
    res.type("application/json").send(await readFile(ALL_FILE, "utf8"));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download the combined JSON file
app.get("/download", (_req, res) => {
  if (!existsSync(ALL_FILE)) return res.status(404).json({ error: "no data yet" });
  res.download(path.resolve(ALL_FILE), "all-pdfs.json");
});

// Manual sync trigger — returns immediately, runs in background.
// Works with GET (browser) or POST. Check progress at "/".
// Optional: set SYNC_TOKEN env and call /sync?token=XXXX
async function syncHandler(req, res) {
  if (SYNC_TOKEN && req.query.token !== SYNC_TOKEN)
    return res.status(401).json({ error: "bad token" });
  const course = req.query.course ? String(req.query.course) : null;
  if (!(await startSync(course)))
    return res.status(409).json({ error: "sync already running" });
  res.status(202).json({ started: true, course, check: "GET /" });
}
app.post("/sync", syncHandler);
app.get("/sync", syncHandler);

// Start
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on :${PORT}`);
  console.log(`[cron] Scheduled: "${SYNC_CRON}" (UTC)`);
  if (RUN_ON_START) startSync();
});
