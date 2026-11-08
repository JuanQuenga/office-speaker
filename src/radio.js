// Internet radio: station search through Radio Browser (radio-browser.info,
// a free, community-run directory), and a local stream proxy that pulls
// "now playing" song titles out of ICY (SHOUTcast/Icecast) metadata.

"use strict";

const http = require("node:http");
const https = require("node:https");

const API = "https://all.api.radio-browser.info/json";
// Chromium can play these directly; HLS playlists and odd codecs are left out.
const PLAYABLE = new Set(["MP3", "AAC", "AAC+", "OGG", "OPUS", "FLAC"]);
const RESULT_LIMIT = 60;

/** Electron's network stack: system proxy, certificate store, and ICY status lines. */
function electronNet() {
  try {
    const { net } = require("electron");
    return net?.request ? net : null;
  } catch {
    return null;
  }
}

function netFetch(url, options) {
  const net = electronNet();
  return net?.fetch ? net.fetch(url, options) : fetch(url, options);
}

class RadioDirectory {
  constructor({ userAgent, log = () => {} }) {
    this.userAgent = userAgent;
    this.log = log;
  }

  async request(path, params = {}) {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await netFetch(url, {
      headers: { "User-Agent": this.userAgent },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Radio Browser answered ${response.status}`);
    return response.json();
  }

  async stations(path, params = {}) {
    const rows = await this.request(path, {
      hidebroken: "true",
      order: "clickcount",
      reverse: "true",
      limit: RESULT_LIMIT * 2, // some get filtered out below
      ...params,
    });
    const seen = new Set();
    const stations = [];
    for (const row of rows) {
      const station = toStation(row);
      if (!station) continue;
      // The directory has many duplicates of big stations.
      const key = `${station.name.toLowerCase()}|${station.country}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stations.push(station);
      if (stations.length >= RESULT_LIMIT) break;
    }
    return stations;
  }

  popular() {
    return this.stations("/stations/search", {});
  }

  search(query) {
    return this.stations("/stations/search", { name: query });
  }

  byTag(tag) {
    return this.stations("/stations/search", { tag, tagExact: "false" });
  }

  /** Radio Browser asks clients to report plays; it powers their popularity ranking. */
  reportClick(stationId) {
    this.request(`/url/${encodeURIComponent(stationId)}`).catch(() => {});
  }
}

function toStation(row) {
  const url = row.url_resolved || row.url;
  if (!url || row.hls === 1 || !/^https?:\/\//i.test(url)) return null;
  const codec = String(row.codec || "").toUpperCase();
  if (!PLAYABLE.has(codec)) return null;
  return {
    id: row.stationuuid,
    name: String(row.name || "").trim() || "Unnamed station",
    url,
    favicon: /^https:\/\//i.test(row.favicon || "") ? row.favicon : null,
    homepage: row.homepage || null,
    country: row.country || "",
    countryCode: row.countrycode || "",
    tags: String(row.tags || "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 4),
    codec,
    bitrate: Number(row.bitrate) || 0,
  };
}

/** A station as saved in settings (favorites, recents): keep only known fields. */
function cleanStation(input) {
  if (!input || typeof input !== "object" || typeof input.url !== "string") return null;
  if (!/^https?:\/\//i.test(input.url)) return null;
  return {
    id: String(input.id ?? input.url),
    name: String(input.name ?? "Radio").slice(0, 120),
    url: input.url,
    favicon: typeof input.favicon === "string" && /^https:\/\//i.test(input.favicon) ? input.favicon : null,
    homepage: typeof input.homepage === "string" ? input.homepage : null,
    country: String(input.country ?? ""),
    countryCode: String(input.countryCode ?? ""),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 4) : [],
    codec: String(input.codec ?? ""),
    bitrate: Number(input.bitrate) || 0,
  };
}

// ---------------------------------------------------------------- stream proxy

/**
 * Relays a station's stream to the audio player while reading ICY metadata
 * (the song title most stations embed every few KB) out of it.
 *
 * @param {string} url upstream stream
 * @param {http.ServerResponse} res
 * @param {{ userAgent: string, onTitle: (title: string) => void, onError: (message: string) => void }} hooks
 */
function relayStream(url, res, hooks) {
  let target;
  try {
    target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("not http");
  } catch {
    hooks.onError("The station's address is invalid");
    res.writeHead(502).end();
    return;
  }

  const fail = (message) => {
    hooks.onError(message);
    if (!res.headersSent) res.writeHead(502);
    res.end();
  };

  const net = electronNet();
  if (net) {
    // Follows redirects itself, uses the system proxy, and accepts "ICY 200 OK".
    const request = net.request({ url: target.toString(), redirect: "follow", useSessionCookies: false });
    request.setHeader("Icy-MetaData", "1");
    request.setHeader("User-Agent", hooks.userAgent);
    request.on("response", (response) => {
      const header = (name) => {
        const value = response.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      if (response.statusCode !== 200) {
        fail(`The station answered ${response.statusCode}`);
        request.abort();
        return;
      }
      relayBody(response, res, header, hooks);
    });
    request.on("error", (error) => fail(`Couldn't reach the station (${error.message})`));
    res.on("close", () => request.abort());
    request.end();
    return;
  }

  // Outside Electron (tests): plain Node HTTP with manual redirects.
  const get = (current, redirects) => {
    const client = current.protocol === "https:" ? https : http;
    const upstream = client.get(
      current,
      { headers: { "Icy-MetaData": "1", "User-Agent": hooks.userAgent, Accept: "*/*" }, timeout: 15000 },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location && redirects < 5) {
          response.resume();
          let next;
          try {
            next = new URL(response.headers.location, current);
            if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("not http");
          } catch {
            fail("The station redirected to an invalid address");
            return;
          }
          get(next, redirects + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          fail(`The station answered ${status}`);
          return;
        }
        relayBody(response, res, (name) => response.headers[name], hooks);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timed out")));
    upstream.on("error", (error) => fail(`Couldn't reach the station (${error.message})`));
    res.on("close", () => upstream.destroy());
  };
  get(target, 0);
}

/** Copies audio to the player, pulling ICY metadata blocks out of the stream. */
function relayBody(response, res, header, hooks) {
  let type = String(header("content-type") || "audio/mpeg").split(";")[0].trim();
  if (type === "audio/aacp" || type === "audio/aac+") type = "audio/aac";
  if (!type.startsWith("audio/") && type !== "application/ogg") type = "audio/mpeg";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });

  const metaInt = Number(header("icy-metaint")) || 0;
  // Stream layout: [metaInt audio bytes][1 byte: n][n*16 metadata bytes], repeated.
  let audioLeft = metaInt;
  let metaLeft = -1; // -1: next byte is the metadata length
  let meta = [];
  response.on("data", (chunk) => {
    if (!metaInt) {
      res.write(chunk);
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (audioLeft > 0) {
        const take = Math.min(audioLeft, chunk.length - offset);
        res.write(chunk.subarray(offset, offset + take));
        audioLeft -= take;
        offset += take;
      } else if (metaLeft === -1) {
        metaLeft = chunk[offset] * 16;
        offset += 1;
        meta = [];
        if (metaLeft === 0) {
          metaLeft = -1;
          audioLeft = metaInt;
        }
      } else {
        const take = Math.min(metaLeft, chunk.length - offset);
        meta.push(chunk.subarray(offset, offset + take));
        metaLeft -= take;
        offset += take;
        if (metaLeft === 0) {
          const text = Buffer.concat(meta).toString("utf8").replace(/\0+$/, "");
          const title = text.match(/StreamTitle='(.*?)';/s)?.[1]?.trim();
          if (title !== undefined) hooks.onTitle(title);
          metaLeft = -1;
          audioLeft = metaInt;
        }
      }
    }
  });
  response.on("end", () => res.end());
  response.on("error", () => res.end());
}

module.exports = { RadioDirectory, cleanStation, relayStream };
