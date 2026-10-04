// Daily Next Toppers PDF URL archiver.
// Crawls batches -> folder trees -> pdfurl endpoint and appends new
// records into data/course-<id>.json (a JSON array). Append-only semantics:
// existing records are never modified or deleted.

const BATCHES_URL = "https://mtaiirusapi.onrender.com/api/nt/batches";
const CONTENT_URL = "https://mtaiirusapi.onrender.com/api/nt/content";
const PDF_URL = "https://nexttoppers.nextmate.site/api/course/pdfurl";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "data";

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed [${res.status}] for ${url}`);
  return res.json();
}

function collectBatches(categories, out) {
  for (const cat of categories) {
    for (const b of cat.batches ?? []) {
      out.push({ id: b.id, title: b.title, category: cat.category_name });
    }
    if (cat.sub_categories?.length) collectBatches(cat.sub_categories, out);
  }
}

export async function listCourses() {
  const json = await fetchJson(BATCHES_URL);
  const courses = [];
  collectBatches(json.catalog ?? [], courses);
  const seen = new Set();
  return courses.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function crawlCourse(course) {
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
        return { path: p, items: Array.isArray(json.data) ? json.data : [] };
      } catch {
        return { path: p, items: [] };
      }
    });

    const pdfFolders = [];
    for (const { path: p, items } of lists) {
      for (const item of items) {
        if (item.type !== "folder") continue;
        const childPath = p ? `${p} / ${item.title}` : item.title;
        const counts = item.data?.content_counts;
        const pdfCount = (counts?.pdf?.free ?? 0) + (counts?.pdf?.paid ?? 0);
        if (pdfCount > 0)
          pdfFolders.push({ folderId: item.entity_id, path: childPath });
        if ((counts?.folders?.total ?? 0) > 0)
          queue.push({ folderId: item.entity_id, path: childPath });
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
      } catch {
        return null;
      }
    });
    for (const e of found) if (e) entries.push(e);
  }
  return entries;
}

const keyOf = (e) => `${e.course_id}:${e.folder_id}:${e.file_url}`;

async function appendJson(filePath, records) {
  let existing = [];
  if (existsSync(filePath)) {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
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
  const fresh = records.filter((r) => !keys.has(keyOf(r)));
  const merged = [...existing, ...fresh];
  if (fresh.length) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(merged, null, 2));
  }
  return { added: fresh.length, total: merged.length };
}

export async function runSync(onlyCourseId = null) {
  const courses = await listCourses();
  const targets = onlyCourseId
    ? courses.filter((c) => c.id === onlyCourseId)
    : courses;

  const summary = [];
  let addedTotal = 0;

  for (const course of targets) {
    try {
      const entries = await crawlCourse(course);
      const filePath = path.join(DATA_DIR, `course-${course.id}.json`);
      const { added, total } = await appendJson(filePath, entries);
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
  console.log(`Done. ${addedTotal} new PDF URL(s) added.`);
  return { addedTotal, summary, finished_at: new Date().toISOString() };
}

// CLI mode: `node sync.mjs [courseId]`
const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("sync.mjs");

if (isDirect) {
  const onlyCourse = process.argv[2] ? Number(process.argv[2]) : null;
  runSync(onlyCourse).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
