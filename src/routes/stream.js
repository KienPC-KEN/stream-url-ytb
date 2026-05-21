const { Router } = require("express");
const yts = require("youtube-search-api");
const { streamCache, searchCache, getRemainingTtlMs } = require("../cache");
const {
  getOrFetchStream,
  refreshStreamSilently,
  STREAM_REFRESH_THRESHOLD_MS,
  UNAVAILABLE_SENTINEL,
} = require("../ytdlp");

const router = Router();

// ─── Fallback: thử lần lượt các video trong search cache ─────────────────────

/**
 * Tìm trong search cache (hoặc gọi lại YT) video nào stream được,
 * bỏ qua các id trong excludeIds (đã biết unavailable).
 */
const fetchStreamWithFallback = async (keyword, excludeIds = new Set()) => {
  // Lấy danh sách từ search cache nếu có
  const searchKey = `search:${keyword.toLowerCase()}`;
  let items = searchCache.get(searchKey) ?? [];

  // Nếu search cache miss (hiếm), gọi lại YT
  if (!items.length) {
    const result = await yts
      .GetListByKeyword(keyword, true, 15)
      .catch(() => ({ items: [] }));
    items = result.items ?? [];
  }

  // Thử từng video cho đến khi có cái nào stream được
  for (const item of items) {
    const id = item.id;
    if (!id || excludeIds.has(id)) continue;

    const videoUrl = `https://www.youtube.com/watch?v=${id}`;
    try {
      const payload = await getOrFetchStream(videoUrl);
      console.log(`[stream:fallback] ✓ using ${id} (keyword: "${keyword}")`);
      return { ...payload, videoId: id };
    } catch (err) {
      console.warn(`[stream:fallback] ✗ ${id}: ${err.message}`);
      excludeIds.add(id);
      // Chỉ skip nếu permanent; lỗi tạm thời (timeout) → dừng, không thử tiếp
      if (!err.permanent) break;
    }
  }

  throw new Error(`No playable video found for keyword: "${keyword}"`);
};

// ─── Route ────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const start = Date.now();
  const videoUrl = String(req.query.url ?? "").trim();
  const keyword = String(req.query.keyword ?? "").trim(); // optional: dùng để fallback
  const elapsed = () => `${Date.now() - start}ms`;

  if (!videoUrl) return res.status(400).json({ message: "Missing url" });

  const key = `stream:${videoUrl}`;

  try {
    // ── Cache hit ──
    const cached = streamCache.get(key);

    if (cached && cached !== UNAVAILABLE_SENTINEL) {
      if (getRemainingTtlMs(streamCache, key) < STREAM_REFRESH_THRESHOLD_MS) {
        console.log(`[stream] proactive refresh: ${videoUrl}`);
        refreshStreamSilently(videoUrl);
      }
      console.log(`[stream] cache hit (${elapsed()})`);
      return res.json({ ...cached, executionTime: elapsed() });
    }

    // ── Video đã biết unavailable + có keyword → fallback ngay ──
    if (cached === UNAVAILABLE_SENTINEL && keyword) {
      const videoId = videoUrl.split("v=")[1]?.split("&")[0];
      const payload = await fetchStreamWithFallback(
        keyword,
        new Set([videoId].filter(Boolean)),
      );
      console.log(`[stream] unavailable→fallback (${elapsed()})`);
      return res.json({ ...payload, executionTime: elapsed(), fallback: true });
    }

    // ── Cold fetch ──
    try {
      const payload = await getOrFetchStream(videoUrl);
      console.log(`[stream] fetched (${elapsed()})`);
      return res.json({ ...payload, executionTime: elapsed() });
    } catch (err) {
      // Permanent error + có keyword → thử fallback
      if (err.permanent && keyword) {
        console.warn(
          `[stream] permanent error, trying fallback for "${keyword}"`,
        );
        const videoId = videoUrl.split("v=")[1]?.split("&")[0];
        const payload = await fetchStreamWithFallback(
          keyword,
          new Set([videoId].filter(Boolean)),
        );
        return res.json({
          ...payload,
          executionTime: elapsed(),
          fallback: true,
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("[stream] error:", err.message);
    return res
      .status(500)
      .json({ message: "Get stream failed", detail: err.message });
  }
});

module.exports = router;
