const { Router } = require("express");
const yts = require("youtube-search-api");
const { searchCache, streamCache } = require("../cache");
const { fetchStreamSilently, prefetchTopResults } = require("../ytdlp");

const router = Router();

const MAX_DURATION_SECONDS = 480; // 8 min
const SEARCH_RESULT_LIMIT = 15;

// Key: normalised keyword → Promise<items[]>
const pendingSearches = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const parseDurationSeconds = (text = "") => {
  const parts = text.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
};

const shouldSkip = (item) => {
  const title = String(item.title ?? "").toLowerCase();
  if (title.includes("karaoke")) return true;
  const seconds = parseDurationSeconds(item.length?.simpleText);
  if (seconds > MAX_DURATION_SECONDS) return true;
  return false;
};

const toResultItem = (item) => ({
  id: item.id,
  title: item.title,
  thumbnail:
    item.thumbnail?.thumbnails?.[0]?.url ?? item.thumbnail?.url ?? null,
  channel: item.channelTitle ?? null,
  duration: item.length?.simpleText || null,
});

// ─── Route ────────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  const keyword = String(req.query.keyword ?? "").trim();
  if (!keyword) return res.status(400).json({ message: "Missing keyword" });

  const key = `search:${keyword.toLowerCase()}`;

  // Cache hit
  const cached = searchCache.get(key);
  if (cached) {
    console.log(`[search] cache hit: "${keyword}"`);
    // Re-prefetch top item nếu stream cache đã expire (e.g. server restart)
    const firstId = cached[0]?.id;
    if (
      firstId &&
      !streamCache.has(`stream:https://www.youtube.com/watch?v=${firstId}`)
    ) {
      fetchStreamSilently(
        `https://www.youtube.com/watch?v=${firstId}`,
        "prefetch",
      );
    }
    return res.json(cached);
  }

  // Dedup concurrent searches
  if (pendingSearches.has(key)) {
    try {
      return res.json(await pendingSearches.get(key));
    } catch {
      return res.status(500).json({ message: "Search failed" });
    }
  }

  const promise = (async () => {
    const result = await yts.GetListByKeyword(
      keyword,
      true,
      SEARCH_RESULT_LIMIT,
    );
    const items = (result.items ?? [])
      .filter((i) => !shouldSkip(i))
      .map(toResultItem);

    searchCache.set(key, items);
    prefetchTopResults(items);

    return items;
  })()
    .catch((err) => {
      console.error("[search] error:", err.message);
      throw err;
    })
    .finally(() => pendingSearches.delete(key));

  pendingSearches.set(key, promise);

  try {
    return res.json(await promise);
  } catch {
    return res.status(500).json({ message: "Search failed" });
  }
});

module.exports = router;
