const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const CACHE_FILE = path.join(ROOT, "dashboard-cache.json");
const GROUP_ID = "117";
const PHASE_LIMIT_AMPS = 16;
const WARNING_RATIO = 0.8;
const ALARM_RATIO = 1;
const STATUS_LABELS = {
  ok: "OK",
  watch: "Review",
  warning: "Review",
  alarm: "Alarm",
  unknown: "Unknown"
};

loadEnv(path.join(ROOT, "ro.env"));
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const ZBX_URL = process.env.ZBX_URL;
const ZBX_API_TOKEN = process.env.ZBX_API_TOKEN;
let latestPayload = readCachedPayload();

const ITEM_KEYS = [
  "pdu_Meter_all-IRMS",
  "pdu_Meter_all-kWS_average_load",
  "pdu_Phase_avg_all",
  "pdu_Phase_1_percentage_load",
  "pdu_Phase_2_percentage_load",
  "pdu_Phase_3_percentage_load",
  "pdu_Meter1-IRMS",
  "pdu_Meter2-IRMS",
  "pdu_Meter3-IRMS",
  "pdu_Meter1-KW",
  "pdu_Meter2-KW",
  "pdu_Meter3-KW",
  "pdu_Meter1-VRMS",
  "pdu_Meter2-VRMS",
  "pdu_Meter3-VRMS"
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/power") {
      await handlePower(req, res);
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, zabbixConfigured: Boolean(ZBX_URL && ZBX_API_TOKEN) });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      await serveDashboardHtml(res);
      return;
    }
    serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected dashboard error", detail: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Link Financial Suite D dashboard listening on http://localhost:${PORT}`);
});

async function handlePower(req, res) {
  const payload = await getPowerPayload();
  sendJson(res, 200, payload);
}

async function getPowerPayload() {
  if (!ZBX_URL || !ZBX_API_TOKEN) {
    throw new Error("Missing ZBX_URL or ZBX_API_TOKEN. Create .env or ro.env first.");
  }

  const hosts = await zabbix("host.get", {
    output: ["hostid", "host", "name", "status"],
    groupids: [GROUP_ID],
    sortfield: "name"
  });

  const suiteHosts = hosts
    .filter((host) => !/^B/i.test(host.host))
    .filter((host) => /Link-Financial\.Rack\.R3P(9|10|11)\.(Green|Orange)\.PDU/i.test(host.host));

  const items = await zabbix("item.get", {
    output: ["itemid", "hostid", "name", "key_", "lastvalue", "units", "lastclock", "status", "state"],
    hostids: suiteHosts.map((host) => host.hostid),
    filter: { key_: ITEM_KEYS },
    sortfield: "name"
  });

  const payload = buildDashboardPayload(suiteHosts, items);
  latestPayload = payload;
  writeCachedPayload(payload);
  return payload;
}

function buildDashboardPayload(hosts, items) {
  const byHostId = new Map(hosts.map((host) => [host.hostid, host]));
  const itemMap = new Map();
  for (const item of items) {
    const host = byHostId.get(item.hostid);
    if (!host) continue;
    if (!itemMap.has(host.hostid)) itemMap.set(host.hostid, new Map());
    itemMap.get(host.hostid).set(item.key_, item);
  }

  const pdus = hosts.map((host) => {
    const map = itemMap.get(host.hostid) || new Map();
    const rackId = host.host.match(/R3P\d+/i)?.[0]?.toUpperCase() || "UNKNOWN";
    const rack = rackId === "UNKNOWN" ? rackId : `D${rackId}`;
    const feed = host.host.match(/\.(Green|Orange)\.PDU/i)?.[1] || "Unknown";
    const phases = [1, 2, 3].map((phase) => ({
      name: `L${phase}`,
      amps: num(map.get(`pdu_Meter${phase}-IRMS`)?.lastvalue),
      kw: num(map.get(`pdu_Meter${phase}-KW`)?.lastvalue),
      volts: num(map.get(`pdu_Meter${phase}-VRMS`)?.lastvalue),
      share: num(map.get(`pdu_Phase_${phase}_percentage_load`)?.lastvalue),
      status: phaseStatus(num(map.get(`pdu_Meter${phase}-IRMS`)?.lastvalue))
    }));
    const worstPhase = Math.max(...phases.map((phase) => phase.amps));
    const totalAmps = num(map.get("pdu_Meter_all-IRMS")?.lastvalue);
    const loadKw = num(map.get("pdu_Meter_all-kWS_average_load")?.lastvalue);
    const pdu = {
      hostid: host.hostid,
      host: host.host,
      name: host.name,
      rack,
      feed,
      image: feed.toLowerCase() === "green" ? "assets/EFS-Right-PDU.png" : "assets/EFS-Left-PDU.jpg",
      online: host.status === "0",
      lastClock: Math.max(...Array.from(map.values()).map((item) => Number(item.lastclock || 0))),
      totalAmps,
      loadKw,
      averageAmps: num(map.get("pdu_Phase_avg_all")?.lastvalue),
      phases,
      worstPhase,
      headroom: PHASE_LIMIT_AMPS - worstPhase
    };
    pdu.status = pduStatus(pdu);
    return pdu;
  });

  const racks = ["DR3P9", "DR3P10", "DR3P11"].map((rackName) => {
    const rackPdus = pdus.filter((pdu) => pdu.rack === rackName).sort((a, b) => a.feed.localeCompare(b.feed));
    const rack = {
      name: rackName,
      pdus: rackPdus,
      totalKw: sum(rackPdus, "loadKw"),
      totalAmps: sum(rackPdus, "totalAmps"),
      failover: failoverStatus(rackPdus)
    };
    rack.status = rackStatus(rack);
    return rack;
  });

  const suite = {
    groupId: GROUP_ID,
    generatedAt: new Date().toISOString(),
    limitAmps: PHASE_LIMIT_AMPS,
    warningAmps: PHASE_LIMIT_AMPS * WARNING_RATIO,
    alarmAmps: PHASE_LIMIT_AMPS * ALARM_RATIO,
    rackCount: racks.length,
    pduCount: pdus.length,
    totalKw: sum(pdus, "loadKw"),
    totalAmps: sum(pdus, "totalAmps"),
    worstPhase: Math.max(...pdus.map((pdu) => pdu.worstPhase), 0)
  };
  suite.status = suiteStatus(racks);

  return { suite, racks };
}

function phaseStatus(amps) {
  if (!Number.isFinite(amps)) return "unknown";
  if (amps >= PHASE_LIMIT_AMPS * ALARM_RATIO) return "alarm";
  if (amps >= PHASE_LIMIT_AMPS * WARNING_RATIO) return "warning";
  return "ok";
}

function pduStatus(pdu) {
  if (!pdu.online) return "unknown";
  if (pdu.phases.some((phase) => phase.status === "alarm")) return "alarm";
  if (pdu.phases.some((phase) => phase.status === "warning")) return "warning";
  return "ok";
}

function failoverStatus(pdus) {
  if (pdus.length < 2) {
    return { status: "unknown", message: "Need both PDU feeds for failover projection.", projected: [] };
  }

  const projected = pdus.map((target) => {
    const others = pdus.filter((pdu) => pdu.hostid !== target.hostid);
    const phases = target.phases.map((phase, index) => ({
      name: phase.name,
      amps: phase.amps + sum(others.map((pdu) => pdu.phases[index]), "amps"),
      status: phaseStatus(phase.amps + sum(others.map((pdu) => pdu.phases[index]), "amps"))
    }));
    return {
      feed: target.feed,
      maxAmps: Math.max(...phases.map((phase) => phase.amps)),
      phases,
      status: phases.some((phase) => phase.status === "alarm")
        ? "alarm"
        : phases.some((phase) => phase.status === "warning")
          ? "warning"
          : "ok"
    };
  });

  const worst = projected.some((feed) => feed.status === "alarm")
    ? "alarm"
    : projected.some((feed) => feed.status === "warning")
      ? "warning"
      : "ok";
  return {
    status: worst,
    projected,
    message: worst === "ok"
      ? "Either PDU can absorb the current paired phase load below 16A."
      : worst === "warning"
        ? "Failover projection is close to the 16A phase ceiling."
        : "Failover projection exceeds the 16A phase ceiling."
  };
}

function rackStatus(rack) {
  const statuses = [...rack.pdus.map((pdu) => pdu.status), rack.failover.status];
  if (statuses.includes("alarm")) return "alarm";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("watch")) return "watch";
  if (statuses.includes("unknown")) return "unknown";
  return "ok";
}

function suiteStatus(racks) {
  const statuses = racks.map((rack) => rack.status);
  if (statuses.includes("alarm")) return "alarm";
  if (statuses.includes("warning")) return "warning";
  if (statuses.includes("watch")) return "watch";
  if (statuses.includes("unknown")) return "unknown";
  return "ok";
}

async function zabbix(method, params) {
  const apiUrl = `${ZBX_URL.replace(/\/$/, "")}/api_jsonrpc.php`;
  const body = JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() });
  let json;
  try {
    json = await postJson(apiUrl, body, true);
  } catch (error) {
    if (!isCertificateChainError(error)) throw error;
    json = await postJson(apiUrl, body, false);
  }
  if (json.error) {
    throw new Error(json.error?.data || json.error?.message || `Zabbix request failed: ${method}`);
  }
  return json.result || [];
}

function postJson(apiUrl, body, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl);
    const request = https.request({
      method: "POST",
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      rejectUnauthorized,
      headers: {
        "Content-Type": "application/json-rpc",
        Authorization: `Bearer ${ZBX_API_TOKEN}`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        try {
          const json = JSON.parse(text);
          if (response.statusCode < 200 || response.statusCode > 299) {
            reject(new Error(json.error?.data || json.error?.message || `HTTP ${response.statusCode}`));
            return;
          }
          resolve(json);
        } catch (error) {
          reject(new Error(`Invalid Zabbix response: ${error.message}`));
        }
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function isCertificateChainError(error) {
  return ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error.code);
}

async function serveDashboardHtml(res) {
  const filePath = path.join(PUBLIC_DIR, "index.html");
  fs.readFile(filePath, "utf8", async (error, template) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const payload = await getPowerPayload();
      const html = template
        .replace('<section class="racks" id="racks"></section>', `<section class="racks" id="racks">${renderRacksHtml(payload.racks)}</section>`)
        .replace('<section class="updated" id="lastUpdated">Waiting for first refresh...</section>', `<section class="updated" id="lastUpdated">Updated ${htmlEscape(new Date(payload.suite.generatedAt).toLocaleString("en-GB"))}</section>`);
      sendHtml(res, html);
    } catch (renderError) {
      console.error(renderError);
      if (latestPayload) {
        const cachedHtml = template
          .replace('<section class="racks" id="racks"></section>', `<section class="racks" id="racks">${renderRacksHtml(latestPayload.racks)}</section>`)
          .replace('<section class="updated" id="lastUpdated">Waiting for first refresh...</section>', `<section class="updated" id="lastUpdated">Updated ${htmlEscape(new Date(latestPayload.suite.generatedAt).toLocaleString("en-GB"))} using last successful refresh</section>`);
        sendHtml(res, cachedHtml);
        return;
      }
      sendHtml(res, template);
    }
  });
}

function renderRacksHtml(racks) {
  return racks.map((rack) => `
    <article class="rack">
      <div class="rack-header">
        <h2>${htmlEscape(rack.name)}</h2>
        ${renderStatusPill(rack.status)}
      </div>
      ${renderFailoverHtml(rack)}
      <div class="rack-body">
        ${rack.pdus.map(renderPduHtml).join("")}
      </div>
    </article>
  `).join("");
}

function renderFailoverHtml(rack) {
  const projections = rack.failover.projected || [];
  return `
    <div class="failover">
      <div class="failover-title">
        <strong>Worst-case paired PDU projection</strong>
        ${renderStatusPill(rack.failover.status)}
      </div>
      <p>${htmlEscape(rack.failover.message)}</p>
      <div class="projection">
        ${projections.map((projection) => `
          <div>
            <strong>${htmlEscape(projection.feed)} carries pair</strong><br>
            Max phase ${fmt(projection.maxAmps, 2)} A
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderPduHtml(pdu) {
  return `
    <section class="pdu-card">
      <img src="${htmlEscape(pdu.image)}" alt="${htmlEscape(pdu.feed)} PDU">
      <div>
        <div class="pdu-head">
          <div class="pdu-title">
            <h3>${htmlEscape(pdu.feed)} PDU</h3>
            <span>${htmlEscape(pdu.host)}</span>
          </div>
          ${renderStatusPill(pdu.status)}
        </div>
        <div class="phase-list">
          ${pdu.phases.map(renderPhaseHtml).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderPhaseHtml(phase) {
  const percent = Math.max(0, Math.min(100, (phase.amps / PHASE_LIMIT_AMPS) * 100));
  return `
    <div class="phase-row">
      <strong>${htmlEscape(phase.name)}</strong>
      <div class="bar"><i class="${htmlEscape(phase.status)}" style="width:${percent}%"></i></div>
      <span>${fmt(phase.amps, 2)} A</span>
    </div>
  `;
}

function renderStatusPill(status) {
  return `<span class="status-pill"><span class="status-dot ${htmlEscape(status)}"></span>${htmlEscape(STATUS_LABELS[status] || status)}</span>`;
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": [".html", ".css", ".js"].includes(path.extname(filePath).toLowerCase())
        ? "no-store"
        : "public, max-age=3600"
    });
    res.end(content);
  });
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  }[ext] || "application/octet-stream";
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const [key, ...value] = line.split("=");
    if (!process.env[key]) process.env[key] = value.join("=").trim();
  }
}

function readCachedPayload() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (error) {
    console.warn(`Unable to read dashboard cache: ${error.message}`);
    return null;
  }
}

function writeCachedPayload(payload) {
  fs.writeFile(CACHE_FILE, JSON.stringify(payload), (error) => {
    if (error) console.warn(`Unable to write dashboard cache: ${error.message}`);
  });
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(items, key) {
  return items.reduce((total, item) => total + num(item?.[key]), 0);
}

function fmt(value, decimals) {
  if (!Number.isFinite(Number(value))) return "0";
  return Number(value).toLocaleString("en-GB", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
