// server.js — PDF fetcher from Firebase Storage (public access)
// Uses Firebase Web SDK — no service account key needed

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Firebase Config (public web config) ────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDZmIAuBBJq3S_3Px-4BUYMyc0qhWPcQdg",
  authDomain: "pdfnt-efaa7.firebaseapp.com",
  databaseURL: "https://pdfnt-efaa7-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pdfnt-efaa7",
  storageBucket: "pdfnt-efaa7.firebasestorage.app",
  messagingSenderId: "905789895931",
  appId: "1:905789895931:web:e1baa24e64d0c08458ec5e"
};

// ─── Build public Storage download URL directly ─────────────────────────────
// Format:
// https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{urlEncodedPath}?alt=media
function buildPublicUrl(course_id, entity_id) {
  const filePath = `pdfs/${course_id}/${entity_id}`;
  const encoded = encodeURIComponent(filePath);
  return `https://firebasestorage.googleapis.com/v0/b/${firebaseConfig.storageBucket}/o/${encoded}?alt=media`;
}

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "PDF Fetcher API",
    endpoints: {
      fetch: "/api/pdf/:course_id/:entity_id",
      stream: "/api/pdf/stream/:course_id/:entity_id",
    },
  });
});

// ─── ROUTE 1: Return JSON with public URL ───────────────────────────────────
app.get("/api/pdf/:course_id/:entity_id", async (req, res) => {
  try {
    const { course_id, entity_id } = req.params;
    const url = buildPublicUrl(course_id, entity_id);

    // Verify it exists
    const check = await fetch(url, { method: "HEAD" });
    if (!check.ok) {
      return res.status(404).json({
        success: false,
        error: "PDF not found",
        path: `pdfs/${course_id}/${entity_id}`,
      });
    }

    res.json({
      success: true,
      course_id,
      entity_id,
      path: `pdfs/${course_id}/${entity_id}`,
      url,
      contentType: check.headers.get("content-type"),
      size: Number(check.headers.get("content-length")) || 0,
    });
  } catch (error) {
    console.error("PDF error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── ROUTE 2: Stream the PDF through your server ────────────────────────────
app.get("/api/pdf/stream/:course_id/:entity_id", async (req, res) => {
  try {
    const { course_id, entity_id } = req.params;
    const url = buildPublicUrl(course_id, entity_id);

    const upstream = await fetch(url);

    if (!upstream.ok) {
      return res.status(404).json({
        success: false,
        error: "PDF not found",
        path: `pdfs/${course_id}/${entity_id}`,
      });
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(entity_id)}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");

    const size = upstream.headers.get("content-length");
    if (size) res.setHeader("Content-Length", size);

    // Pipe the stream
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    };
    await pump();
  } catch (error) {
    console.error("PDF stream error:", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// ─── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ PDF Fetcher running on http://localhost:${PORT}`);
  console.log(`   Bucket: ${firebaseConfig.storageBucket}`);
});
