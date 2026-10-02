import {
  WINDY_API_BASE,
  WINDY_IMAGE_CACHE_MS,
  WINDY_FETCH_TIMEOUT_MS,
  WINDY_CONTINENTS,
  DEFAULT_WINDY_MAX_SOURCES,
  DEFAULT_WINDY_PAGES_PER_CONTINENT,
} from './constants.js';
import {
  fallbackHeadingFromId,
  toFiniteNumber,
  isPlausibleLatLon,
} from './normalize.js';
import { fetchCctvImageFromUpstream } from './media.js';

/**
 * Windy Webcams API v3 pack (https://api.windy.com/webcams/docs).
 *
 * The world's largest public webcam directory (~68k cameras). Auth is the
 * `x-windy-api-key` header; the key comes from the WINDY_API_KEY env var and
 * is never written anywhere. Free-tier image URLs carry a token that expires
 * after 10 minutes, so frame serving keeps a per-camera URL cache
 * (WINDY_IMAGE_CACHE_MS, 8 min) and refreshes via the detail endpoint on
 * expiry/401. Player URLs are Windy iframe embeds (not HLS), so every Windy
 * camera is an 'image' feed on the existing 2.5s refresh cadence; the embed
 * URL rides along as `playerUrl` for future panel use.
 */

/** Trimmed API key, or '' when unset. */
function windyApiKey() {
  return String(process.env.WINDY_API_KEY || '').trim();
}

/** True when the pack can talk to Windy at all. */
export function windyApiConfigured() {
  return windyApiKey().length > 0;
}

/**
 * GET one Windy v3 path with the API key header. Returns parsed JSON, or
 * null on auth failure / rate limit / transport error (each logged once per
 * call site context).
 *
 * @param {string} path - Path + query, e.g. "/webcams?limit=50".
 * @param {string} context - Log label for failures.
 * @returns {Promise<object|null>}
 */
async function windyGet(path, context) {
  const key = windyApiKey();
  if (!key) return null;
  let resp;
  try {
    resp = await fetch(`${WINDY_API_BASE}${path}`, {
      headers: {
        Accept: 'application/json',
        'x-windy-api-key': key,
        'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
      },
      signal: AbortSignal.timeout(WINDY_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    console.warn(
      '[CCTV] Windy API request failed:',
      context,
      error?.message || error,
    );
    return null;
  }
  if (resp.status === 401 || resp.status === 403) {
    console.warn(
      '[CCTV] Windy API auth failed (HTTP %s) during %s; check WINDY_API_KEY',
      resp.status,
      context,
    );
    return null;
  }
  if (resp.status === 429) {
    console.warn('[CCTV] Windy API rate limited during', context);
    return null;
  }
  if (!resp.ok) {
    console.warn('[CCTV] Windy API HTTP %s during %s', resp.status, context);
    return null;
  }
  try {
    return await resp.json();
  } catch (error) {
    console.warn(
      '[CCTV] Windy API bad JSON during',
      context,
      error?.message || error,
    );
    return null;
  }
}

/** Extract the current snapshot URL from a webcam record (any shape). */
function extractWindyImageUrl(webcam) {
  const images = webcam?.images || {};
  const current = images.current || images.preview || {};
  const url = String(
    current.url || current.previewUrl || images.url || '',
  ).trim();
  return url;
}

/** Extract the live player embed URL, if the webcam publishes one. */
function extractWindyPlayerUrl(webcam) {
  const player = webcam?.player || {};
  return String(player.live || player.embed || '').trim();
}

/** Extract normalized location fields from a webcam record. */
function extractWindyLocation(webcam) {
  const loc = webcam?.location || {};
  return {
    lat: toFiniteNumber(loc.latitude ?? loc.lat),
    lon: toFiniteNumber(loc.longitude ?? loc.lon),
    city: String(loc.city || '').trim(),
    country: String(loc.country || '').trim(),
    countryCode: String(loc.countryCode || loc.country_code || '')
      .trim()
      .toUpperCase(),
  };
}

/**
 * Only Windy-served image hosts are accepted for frame URLs. The API serves
 * every webcam image through imgproxy.windy.com; pinning the host keeps a
 * hostile API response from steering the frame proxy at an arbitrary origin
 * (the frame route otherwise only fetches server-registered URLs).
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isWindyImageUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'imgproxy.windy.com' || host.endsWith('.windy.com');
  } catch {
    return false;
  }
}

/**
 * One Windy webcam record -> one normalized CCTV source, or null when the
 * record is unusable (inactive, no coords, no image).
 *
 * Exported for unit tests.
 *
 * @param {object} webcam - Raw webcam object from the v3 API.
 * @returns {?object}
 */
export function windyWebcamToSource(webcam) {
  const webcamId = String(webcam?.webcamId ?? webcam?.id ?? '').trim();
  if (!webcamId) return null;
  // The API returns webcams of all statuses unless filtered; only live ones
  // belong on the globe.
  if (String(webcam?.status || '').toLowerCase() !== 'active') return null;
  const loc = extractWindyLocation(webcam);
  if (!isPlausibleLatLon(loc.lat, loc.lon)) return null;
  const imageUrl = extractWindyImageUrl(webcam);
  if (!isWindyImageUrl(imageUrl)) return null;

  const cameraId = `windy-${webcamId}`;
  const title = String(webcam?.title || `Windy webcam ${webcamId}`).trim();
  return {
    id: cameraId,
    name: title,
    city: loc.city || loc.country || 'Windy',
    cityId: loc.countryCode
      ? `windy-${loc.countryCode.toLowerCase()}`
      : 'windy',
    provider: 'Windy',
    lat: loc.lat,
    lon: loc.lon,
    // No compass heading anywhere in the dataset -> id-hash fallback, low
    // confidence (same personality as headingless TfL/Fintraffic cameras).
    headingDeg: fallbackHeadingFromId(cameraId),
    headingConfidence: 'low',
    pitchDeg: -18,
    fovDeg: 44,
    rangeM: 145,
    mountHeightM: 8,
    groundElevationM: 0, // prior only; the client's ground snap corrects.
    feedType: 'image',
    url: imageUrl,
    snapshotUrl: imageUrl,
    sourceKind: 'windy-webcams',
    license: 'Windy.com Webcams API',
    playerUrl: extractWindyPlayerUrl(webcam),
  };
}

/** Small delay between paged requests to stay polite on the free tier. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch and normalize Windy webcams, spread across continents for global
 * coverage. Each continent contributes up to its share of the pack cap,
 * popularity-first, so the globe fills evenly instead of clustering on the
 * densest region. Every pack failure degrades to [] (logged), never throws.
 *
 * Env knobs: WINDY_API_KEY (required), CCTV_WINDY_MAX_SOURCES (default 600),
 * CCTV_WINDY_PAGES_PER_CONTINENT (default 3, each page is limit=50).
 *
 * @returns {Promise<Array<object>>} Normalized camera source objects.
 */
export async function loadWindySourcesFromApi() {
  if (!windyApiConfigured()) {
    console.warn('[CCTV] WINDY_API_KEY not set; skipping Windy webcam pack');
    return [];
  }
  const maxRaw = Number(
    process.env.CCTV_WINDY_MAX_SOURCES || DEFAULT_WINDY_MAX_SOURCES,
  );
  const maxCount = Number.isFinite(maxRaw)
    ? Math.max(8, Math.min(2000, Math.floor(maxRaw)))
    : DEFAULT_WINDY_MAX_SOURCES;
  const pagesRaw = Number(
    process.env.CCTV_WINDY_PAGES_PER_CONTINENT ||
      DEFAULT_WINDY_PAGES_PER_CONTINENT,
  );
  const pagesPerContinent = Number.isFinite(pagesRaw)
    ? Math.max(1, Math.min(8, Math.floor(pagesRaw)))
    : DEFAULT_WINDY_PAGES_PER_CONTINENT;
  const perContinent = Math.max(
    8,
    Math.ceil(maxCount / WINDY_CONTINENTS.length),
  );

  const cameras = [];
  const seen = new Set();
  for (const continent of WINDY_CONTINENTS) {
    let taken = 0;
    for (let page = 0; page < pagesPerContinent && taken < perContinent; page++) {
      const offset = page * 50;
      // Free tier caps offset at 1000; we never page that deep anyway.
      if (offset >= 1000) break;
      const limit = Math.min(50, perContinent - taken);
      const path =
        `/webcams?limit=${limit}&offset=${offset}` +
        `&continents=${encodeURIComponent(continent)}` +
        `&include=${encodeURIComponent('location,images,player')}` +
        `&sort=popularity&sortDirection=desc&lang=en`;
      const payload = await windyGet(path, `list ${continent}`);
      if (!payload) break; // auth/rate/transport failure: stop this continent
      const rows = Array.isArray(payload?.webcams) ? payload.webcams : [];
      if (!rows.length) break;
      for (const row of rows) {
        const source = windyWebcamToSource(row);
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        cameras.push(source);
        taken += 1;
        if (taken >= perContinent) break;
      }
      const total = Number(payload?.total);
      if (rows.length < limit) break; // last page
      if (Number.isFinite(total) && offset + limit >= total) break;
      await sleep(300);
    }
    await sleep(300);
  }

  const trimmed = cameras.slice(0, maxCount);
  console.log(
    `[CCTV] Loaded Windy webcam sources: ${cameras.length} across ${WINDY_CONTINENTS.length} continents (using ${trimmed.length})`,
  );
  // Prime the frame URL cache so the first frame requests don't all miss.
  const now = Date.now();
  for (const camera of trimmed) {
    const webcamId = camera.id.replace(/^windy-/, '');
    if (camera.snapshotUrl && webcamId) {
      imageUrlCache.set(webcamId, { url: camera.snapshotUrl, fetchedAt: now });
    }
  }
  return trimmed;
}

/**
 * Per-camera fresh image URL cache. Free-tier tokens expire after 10 min;
 * entries are refreshed proactively at 8 min and on demand after a 401.
 *
 * @type {Map<string,{url:string,fetchedAt:number}>}
 */
const imageUrlCache = new Map();

/**
 * Unwrap a detail payload (either `{webcam:{...}}` or the webcam itself) and
 * pull its current image URL.
 */
function extractDetailImageUrl(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const webcam = payload.webcam || payload;
  return extractWindyImageUrl(webcam);
}

/**
 * Fresh (token-valid) image URL for one Windy webcam. Uses the cache when
 * fresh; otherwise calls the detail endpoint once. Returns the stale cached
 * URL as a last resort so a transient API outage degrades to "maybe expired"
 * instead of "definitely nothing".
 *
 * @param {string} webcamId - Numeric Windy webcam id (without the windy- prefix).
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Skip the cache and re-fetch.
 * @returns {Promise<string|null>}
 */
export async function getWindyImageUrl(webcamId, { force = false } = {}) {
  const id = String(webcamId || '').trim();
  if (!id || !windyApiConfigured()) return null;
  const cached = imageUrlCache.get(id);
  if (
    !force &&
    cached &&
    Date.now() - cached.fetchedAt <= WINDY_IMAGE_CACHE_MS
  ) {
    return cached.url;
  }
  const payload = await windyGet(
    `/webcams/${encodeURIComponent(id)}?include=${encodeURIComponent('images')}&lang=en`,
    `detail ${id}`,
  );
  const url = extractDetailImageUrl(payload);
  if (isWindyImageUrl(url)) {
    imageUrlCache.set(id, { url, fetchedAt: Date.now() });
    return url;
  }
  if (url) {
    console.warn('[CCTV] Windy detail returned a non-Windy image host; refusing');
  }
  return cached?.url || null;
}

/** Drop one camera's cached image URL (after a 401). */
export function invalidateWindyImageUrl(webcamId) {
  imageUrlCache.delete(String(webcamId || '').trim());
}

/**
 * Fetch one current frame for a Windy camera, refreshing the tokenized image
 * URL on expiry. Returns the media.js result shape ({ok, body, contentType})
 * or null when nothing usable came back (the caller runs its fallbacks).
 *
 * @param {string} cameraId - Catalog id, `windy-{webcamId}`.
 * @returns {Promise<{ok:true,body:Buffer,contentType:string}|null>}
 */
export async function fetchWindyFrameImage(cameraId) {
  const webcamId = String(cameraId || '').replace(/^windy-/, '');
  if (!webcamId) return null;
  let url = await getWindyImageUrl(webcamId);
  let image = url ? await fetchCctvImageFromUpstream(url) : null;
  if (!image?.ok) {
    // Token probably expired (Windy answers 401 on stale tokens): refresh
    // once and retry before giving up to the fallback chain.
    invalidateWindyImageUrl(webcamId);
    url = await getWindyImageUrl(webcamId, { force: true });
    image = url ? await fetchCctvImageFromUpstream(url) : null;
  }
  return image?.ok ? image : null;
}
