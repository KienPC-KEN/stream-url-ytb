const youtubedl = require("youtube-dl-exec").create("yt-dlp");
const { streamCache } = require("./cache");
const path = require("path");
const fs = require("fs");

// ─── Constants ────────────────────────────────────────────────────────────────

const AUDIO_FORMAT =
  "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio";

const STREAM_URL_TTL_MS = 55 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const STREAM_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

const PERMANENT_ERROR_PATTERNS = [
  "not available",
  "has been removed",
  "private video",
  "This video is unavailable",
  "copyright",
  "account associated",
  "This video is not available",
];

const isPermanentError = (message = "") =>
  PERMANENT_ERROR_PATTERNS.some((p) => message.includes(p));

// ─── Cookies ──────────────────────────────────────────────────────────────────
// Render không có browser → dùng file cookies.txt (Netscape format).
// Đặt file tại /app/cookies.txt hoặc trỏ qua env YTDLP_COOKIES_FILE.
// Hướng dẫn export: dùng extension "Get cookies.txt LOCALLY" trên Chrome/Firefox,
// đăng nhập YouTube rồi export, upload lên Render dưới dạng Secret File.

const COOKIES_FILE =
  process.env.YTDLP_COOKIES_FILE ?? path.join(process.cwd(), "cookies.txt");
const hasCookies = fs.existsSync(COOKIES_FILE);

if (hasCookies) {
  console.log(`[yt-dlp] Using cookies file: ${COOKIES_FILE}`);
} else {
  console.warn(
    "[yt-dlp] No cookies file found — YouTube may block datacenter IPs.",
  );
}

const YT_DLP_FLAGS = {
  noWarnings: true,
  noCheckCertificates: true,
  noPlaylist: true,
  socketTimeout: 15,
  retries: 3,
  // Dùng cookies nếu có
  ...(hasCookies ? { cookies: COOKIES_FILE } : {}),
};

// ─── Pending map ──────────────────────────────────────────────────────────────
console.log("[cookies] file exists:", fs.existsSync(COOKIES_FILE));
console.log("[cookies] path:", COOKIES_FILE);

const pendingStreams = new Map();

// ─── Core fetch ───────────────────────────────────────────────────────────────

const fetchStream = async (videoUrl) => {
  let result;
  try {
    result = await Promise.race([
      youtubedl.exec(videoUrl, {
        ...YT_DLP_FLAGS,
        print: ["url", "duration"],
        format: AUDIO_FORMAT,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`yt-dlp timed out after ${FETCH_TIMEOUT_MS}ms`)),
          FETCH_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    const detail = err.stderr?.slice(0, 400) ?? err.message;
    const error = new Error(`yt-dlp failed: ${detail}`);
    error.permanent = isPermanentError(detail);
    throw error;
  }

  const stdout =
    typeof result === "string" ? result : String(result?.stdout ?? "");

  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const streamUrl = lines[0];

  if (!streamUrl) {
    const stderr = result?.stderr?.slice(0, 400) ?? "";
    const error = new Error(`yt-dlp returned empty stdout. stderr: ${stderr}`);
    error.permanent = isPermanentError(stderr);
    throw error;
  }

  return {
    streamUrl,
    duration: parseFloat(lines[1]) || null,
    fetchedAt: Date.now(),
    expiresInMs: STREAM_URL_TTL_MS,
  };
};

// ─── Cache + dedup ────────────────────────────────────────────────────────────

const UNAVAILABLE_SENTINEL = "__unavailable__";

const getOrFetchStream = (videoUrl) => {
  const key = `stream:${videoUrl}`;

  const cached = streamCache.get(key);
  if (cached === UNAVAILABLE_SENTINEL) {
    return Promise.reject(
      Object.assign(new Error("Video unavailable (cached)"), {
        permanent: true,
      }),
    );
  }

  if (pendingStreams.has(key)) return pendingStreams.get(key);

  const promise = fetchStream(videoUrl)
    .then((payload) => {
      streamCache.set(key, payload);
      return payload;
    })
    .catch((err) => {
      if (err.permanent) streamCache.set(key, UNAVAILABLE_SENTINEL, 1800);
      throw err;
    })
    .finally(() => pendingStreams.delete(key));

  pendingStreams.set(key, promise);
  return promise;
};

// ─── Background helpers ───────────────────────────────────────────────────────

const fetchStreamSilently = (videoUrl, label = "bg") => {
  const key = `stream:${videoUrl}`;
  const cached = streamCache.get(key);
  if (cached || pendingStreams.has(key)) return;

  getOrFetchStream(videoUrl)
    .then(() => console.log(`[stream:${label}] ✓ ${videoUrl}`))
    .catch((err) =>
      console.warn(`[stream:${label}] ✗ ${videoUrl}:`, err.message),
    );
};

const refreshStreamSilently = (videoUrl) => {
  const key = `stream:${videoUrl}`;
  if (pendingStreams.has(key)) return;
  streamCache.del(key);

  getOrFetchStream(videoUrl)
    .then(() => console.log(`[stream:refresh] ✓ ${videoUrl}`))
    .catch((err) =>
      console.warn(`[stream:refresh] ✗ ${videoUrl}:`, err.message),
    );
};

const prefetchTopResults = (items, n = 3, staggerMs = 800) => {
  items.slice(0, n).forEach((item, idx) => {
    setTimeout(() => {
      fetchStreamSilently(
        `https://www.youtube.com/watch?v=${item.id}`,
        "prefetch",
      );
    }, idx * staggerMs);
  });
};

module.exports = {
  getOrFetchStream,
  fetchStreamSilently,
  refreshStreamSilently,
  prefetchTopResults,
  STREAM_REFRESH_THRESHOLD_MS,
  UNAVAILABLE_SENTINEL,
};
