const state = {
  refreshMs: 60000
};

const statusLabels = {
  ok: "OK",
  watch: "Review",
  warning: "Review",
  alarm: "Alarm",
  unknown: "Unknown"
};

load();
setInterval(load, state.refreshMs);

async function load() {
  try {
    const response = await fetch("api/power", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load power data");
    render(data);
  } catch (error) {
    document.getElementById("racks").innerHTML = `<section class="rack"><div class="rack-header"><h2>Unable to load</h2></div><div class="failover"><p>${escapeHtml(error.message)}</p></div></section>`;
  }
}

function render(data) {
  const { suite, racks } = data;
  document.getElementById("racks").innerHTML = racks.map(renderRack).join("");
  document.getElementById("lastUpdated").textContent = `Updated ${new Date(suite.generatedAt).toLocaleString()}`;
}

function renderRack(rack) {
  return `
    <article class="rack">
      <div class="rack-header">
        <h2>${rack.name}</h2>
        ${statusPill(rack.status, statusLabels[rack.status])}
      </div>
      ${renderFailover(rack)}
      <div class="rack-body">
        ${rack.pdus.map(renderPdu).join("")}
      </div>
    </article>
  `;
}

function renderFailover(rack) {
  const projections = rack.failover.projected || [];
  return `
    <div class="failover">
      <div class="failover-title">
        <strong>Worst-case paired PDU projection</strong>
        ${statusPill(rack.failover.status, statusLabels[rack.failover.status])}
      </div>
      <p>${rack.failover.message}</p>
      <div class="projection">
        ${projections.map((projection) => `
          <div>
            <strong>${projection.feed} carries pair</strong><br>
            Max phase ${fmt(projection.maxAmps, 2)} A
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderPdu(pdu) {
  return `
    <section class="pdu-card">
      <img src="${pdu.image}" alt="${pdu.feed} PDU">
      <div>
        <div class="pdu-head">
          <div class="pdu-title">
            <h3>${pdu.feed} PDU</h3>
            <span>${pdu.host}</span>
          </div>
          ${statusPill(pdu.status, statusLabels[pdu.status])}
        </div>
        <div class="phase-list">
          ${pdu.phases.map(renderPhase).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderPhase(phase) {
  const percent = Math.max(0, Math.min(100, (phase.amps / 16) * 100));
  return `
    <div class="phase-row">
      <strong>${phase.name}</strong>
      <div class="bar"><i class="${phase.status}" style="width:${percent}%"></i></div>
      <span>${fmt(phase.amps, 2)} A</span>
    </div>
  `;
}

function statusPill(status, label) {
  return `<span class="status-pill"><span class="status-dot ${status}"></span>${label}</span>`;
}

function suiteStatusText(status) {
  if (status === "ok") return "Suite D within 16A phase model";
  if (status === "warning") return "Phase balance should be reviewed for optimal resilience";
  if (status === "alarm") return "PDU not balanced adequately across phases for optimal resilience";
  if (status === "watch") return "Phase balance should be reviewed for optimal resilience";
  return "Suite D state unknown";
}

function fmt(value, decimals) {
  if (!Number.isFinite(Number(value))) return "0";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
