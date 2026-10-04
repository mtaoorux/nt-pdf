# NT PDF Archiver

Crawls Next Toppers batches → folder trees → PDF URLs, stores them in JSON files,
and exposes them via a REST API. Runs a daily cron on Render.

## Local usage

```bash
npm install

# One-shot crawl (writes ./data/course-<id>.json)
npm run sync

# Or crawl just one course
node sync.mjs 123

# Start the API + built-in cron
npm start
```

## API

| Method | Path              | Purpose                                    |
|--------|-------------------|--------------------------------------------|
| GET    | `/`               | Service status + last run                  |
| GET    | `/healthz`        | Health check                               |
| GET    | `/courses`        | List stored courses + counts               |
| GET    | `/courses/:id`    | Full PDF URL array for one course          |
| POST   | `/sync`           | Trigger sync manually (optional `?course=`)|

No authentication — anyone with the URL can call `POST /sync`.

## Data format

Each `data/course-<id>.json` is a JSON array:

```json
[
  {
    "course_id": 123,
    "course_title": "Class 10 Physics",
    "folder_id": "456",
    "folder_path": "Chapter 1 / Notes",
    "title": "Ch 1 Notes",
    "file_url": "https://.../file.pdf",
    "found_at": "2026-10-04T02:31:12.345Z"
  }
]
```

Records are append-only; duplicates (same `course_id` + `folder_id` + `file_url`) are skipped.
