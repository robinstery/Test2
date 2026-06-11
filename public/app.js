"use strict";

const $ = (sel) => document.querySelector(sel);
const NOK = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });
const kr = (n) => NOK.format(n) + " kr";
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let current = null; // aktiv befaring

// --- API-hjelpere -----------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function busy(on, text) {
  $("#busyText").textContent = text || "Analyserer …";
  $("#busy").classList.toggle("hidden", !on);
}

// --- Navigasjon --------------------------------------------------------------

function showList() {
  current = null;
  $("#view-survey").classList.add("hidden");
  $("#view-list").classList.remove("hidden");
  $("#backBtn").classList.add("hidden");
  $("#title").textContent = "Tilstandsanalyse";
  loadList();
}

async function openSurvey(id) {
  current = await api("GET", "/api/surveys/" + id);
  $("#view-list").classList.add("hidden");
  $("#view-survey").classList.remove("hidden");
  $("#backBtn").classList.remove("hidden");
  $("#title").textContent = current.meta.name;
  renderAll();
}

$("#backBtn").addEventListener("click", showList);

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("hidden", p.id !== "tab-" + btn.dataset.tab));
  });
});

// --- Befaringsliste -----------------------------------------------------------

async function loadList() {
  const surveys = await api("GET", "/api/surveys");
  const el = $("#surveyList");
  el.innerHTML = surveys.length ? "" : '<p class="hint">Ingen befaringer ennå – opprett en under.</p>';
  for (const s of surveys) {
    const item = document.createElement("div");
    item.className = "survey-item";
    item.innerHTML = `
      <strong>${esc(s.meta.name)}</strong>
      <small>${esc(s.meta.address)} · ${new Date(s.createdAt).toLocaleDateString("nb-NO")}</small>
      <div class="badges">
        <span class="badge">${s.photoCount} bilder</span>
        <span class="badge ${s.hasBuilding ? "done" : ""}">Bygning</span>
        <span class="badge ${s.hasComponents ? "done" : ""}">Komponenter</span>
        <span class="badge ${s.hasPlan ? "done" : ""}">Tiltaksplan</span>
      </div>`;
    item.addEventListener("click", () => openSurvey(s.id).catch((e) => toast(e.message)));
    el.appendChild(item);
  }
}

$("#newSurveyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const survey = await api("POST", "/api/surveys", {
      name: $("#newName").value.trim(),
      address: $("#newAddress").value.trim(),
      info: $("#newInfo").value.trim()
    });
    e.target.reset();
    await openSurvey(survey.id);
  } catch (err) {
    toast(err.message);
  }
});

// --- Bilder --------------------------------------------------------------------

const MAX_DIM = 1568;

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      resolve(dataUrl.split(",")[1]); // ren base64
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Kunne ikke lese bildet.")); };
    img.src = url;
  });
}

document.querySelectorAll('input[type="file"]').forEach((input) => {
  input.addEventListener("change", async () => {
    const files = [...input.files];
    input.value = "";
    if (!files.length || !current) return;
    busy(true, "Laster opp bilder …");
    try {
      for (const file of files) {
        const data = await resizeImage(file);
        const photo = await api("POST", `/api/surveys/${current.id}/photos`, {
          category: input.dataset.category,
          mediaType: "image/jpeg",
          data
        });
        current.photos.push(photo);
      }
      renderPhotos();
    } catch (err) {
      toast(err.message);
    } finally {
      busy(false);
    }
  });
});

function renderPhotos() {
  for (const cat of ["eksterior", "interior"]) {
    const grid = $("#grid-" + cat);
    grid.innerHTML = "";
    for (const p of current.photos.filter((x) => x.category === cat)) {
      const div = document.createElement("div");
      div.className = "thumb";
      div.innerHTML = `<img src="/photos/${current.id}/${p.id}" alt="" loading="lazy"><button aria-label="Slett">×</button>`;
      div.querySelector("button").addEventListener("click", async () => {
        try {
          await api("DELETE", `/api/surveys/${current.id}/photos/${p.id}`);
          current.photos = current.photos.filter((x) => x.id !== p.id);
          renderPhotos();
        } catch (err) {
          toast(err.message);
        }
      });
      grid.appendChild(div);
    }
  }
}

// --- Analyse: bygning ---------------------------------------------------------

$("#runBuilding").addEventListener("click", async () => {
  busy(true, "Analyserer bygningen … Dette kan ta et par minutter.");
  try {
    current.buildingAnalysis = await api("POST", `/api/surveys/${current.id}/analyze/building`);
    current.actionPlan = null;
    renderAll();
    toast("Bygningsanalyse fullført.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
});

function buildingHtml(b) {
  if (!b) return "";
  return `
  <div class="card">
    <h2>Bygningsbeskrivelse</h2>
    <dl class="kv">
      <dt>Bygningstype</dt><dd>${esc(b.bygningstype)}</dd>
      <dt>Antatt byggeår</dt><dd><strong>${b.byggeaar.estimat}</strong> (${b.byggeaar.fra}–${b.byggeaar.til})</dd>
      <dt>Byggemetode</dt><dd>${esc(b.byggemetode)}</dd>
      <dt>Etasjer</dt><dd>${b.etasjer}</dd>
      <dt>Fundamentering</dt><dd>${esc(b.fundamentering)}</dd>
      <dt>Fasade</dt><dd>${esc(b.fasade.type)} – ${esc(b.fasade.materiale)}. ${esc(b.fasade.beskrivelse)}</dd>
      <dt>Tak</dt><dd>${esc(b.tak.takform)}, ${esc(b.tak.tekking)}. ${esc(b.tak.beskrivelse)}</dd>
      <dt>Dekker</dt><dd>${esc(b.dekker)}</dd>
      <dt>Vinduer</dt><dd>${esc(b.vinduer)}</dd>
    </dl>
    <h3>Datering – begrunnelse</h3>
    <p>${esc(b.byggeaar.begrunnelse)}</p>
    <h3>Helhetsinntrykk</h3>
    <p>${esc(b.helhetsinntrykk)}</p>
    <h3>Observasjoner</h3>
    <ul>${b.observasjoner.map((o) => `<li>${esc(o)}</li>`).join("")}</ul>
    <h3>Usikkerhet</h3>
    <p>${esc(b.usikkerhet)}</p>
  </div>`;
}

// --- Analyse: komponenter -------------------------------------------------------

$("#runComponents").addEventListener("click", async () => {
  busy(true, "Analyserer komponenter … Dette kan ta noen minutter.");
  try {
    current.componentAnalysis = await api("POST", `/api/surveys/${current.id}/analyze/components`);
    current.actionPlan = null;
    renderAll();
    toast("Komponentanalyse fullført.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
});

function tgBadge(tg) {
  return `<span class="tg tg-${esc(tg)}">${esc(tg)}</span>`;
}

function componentsHtml(c) {
  if (!c) return "";
  const rows = [...c.komponenter].sort((a, b) => a.ns3451.localeCompare(b.ns3451));
  return `
  <div class="card">
    <h2>Komponenttabell (NS 3451 / NS 3424)</h2>
    ${rows.map((k) => `
      <div class="comp">
        <div class="head">
          <strong>${esc(k.ns3451)} ${esc(k.komponent)}</strong>
          ${tgBadge(k.tilstandsgrad)}
        </div>
        <div class="sub">${esc(k.ns3451Navn)} · ${esc(k.plassering)} · ${esc(k.materiale)}</div>
        <div class="sub">Antatt alder: ${k.antattAlder} år · Forventet levetid: ${k.forventetLevetid} år · Gjenværende: ${k.gjenvaerendeLevetid} år</div>
        <p>${esc(k.tilstandsbeskrivelse)}</p>
        ${k.skader.length ? `<ul>${k.skader.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
      </div>`).join("")}
  </div>
  <div class="card">
    <h2>Samlet vurdering</h2>
    <p>${esc(c.generellVurdering)}</p>
  </div>`;
}

// --- Tiltaksplan ------------------------------------------------------------------

$("#runPlan").addEventListener("click", async () => {
  busy(true, "Genererer tiltaksplan og 30-årsplan … Dette kan ta noen minutter.");
  try {
    current.actionPlan = await api("POST", `/api/surveys/${current.id}/plan`);
    renderAll();
    toast("Tiltaksplan generert.");
  } catch (err) {
    toast(err.message);
  } finally {
    busy(false);
  }
});

function planHtml(p) {
  if (!p) return "";
  const measures = [...p.tiltak].sort((a, b) => a.prioritet - b.prioritet || a.startAar - b.startAar);
  const byId = Object.fromEntries(p.tiltak.map((t) => [t.id, t]));
  const years = [...p.trettiaarsplan].sort((a, b) => a.aar - b.aar);
  return `
  <div class="card">
    <h2>Oppsummering</h2>
    <div class="sumline"><span>Strakstiltak (innen 1 år)</span><span>${kr(p.oppsummering.strakstiltakNOK)}</span></div>
    <div class="sumline"><span>Første 5 år</span><span>${kr(p.oppsummering.foersteFemAarNOK)}</span></div>
    <div class="sumline"><span>Årlig gjennomsnitt</span><span>${kr(p.oppsummering.aarligGjennomsnittNOK)}</span></div>
    <div class="sumline total"><span>Totalt 30 år</span><span>${kr(p.oppsummering.totaltTrettiAarNOK)}</span></div>
    <h3>Hovedkonklusjon</h3>
    <p>${esc(p.oppsummering.hovedkonklusjon)}</p>
    <p class="disclaimer">Kostnader er grove, AI-genererte overslag inkl. mva. og må kvalitetssikres mot lokale priser og tilbud.</p>
  </div>
  <div class="card">
    <h2>Tiltak</h2>
    ${measures.map((t) => `
      <div class="measure p${t.prioritet}">
        <div class="head">
          <strong>${esc(t.komponent)}</strong>
          <span>${kr(t.kostnadNOK.forventet)}</span>
        </div>
        <div class="sub">NS 3451: ${esc(t.ns3451)} · ${esc(t.type)} · Prioritet ${t.prioritet} · Start ${t.startAar}${t.intervallAar ? " · hvert " + t.intervallAar + ". år" : ""} · ${kr(t.kostnadNOK.lav)}–${kr(t.kostnadNOK.hoey)}</div>
        <p>${esc(t.beskrivelse)}</p>
        <p class="sub">${esc(t.begrunnelse)}</p>
      </div>`).join("")}
  </div>
  <div class="card">
    <h2>30-års vedlikeholds- og utskiftingsplan</h2>
    <table>
      <thead><tr><th>År</th><th>Tiltak</th><th class="num">Kostnad</th></tr></thead>
      <tbody>
        ${years.map((y) => `
          <tr class="year-row">
            <td>${y.aar}</td>
            <td>${y.tiltakIder.map((id) => esc(byId[id] ? byId[id].komponent : "Tiltak " + id)).join(", ")}</td>
            <td class="num">${kr(y.sumNOK)}</td>
          </tr>`).join("")}
      </tbody>
    </table>
  </div>`;
}

// --- Rapport ----------------------------------------------------------------------

function reportHtml() {
  const s = current;
  const date = new Date(s.createdAt).toLocaleDateString("nb-NO");
  let html = `
  <div class="card">
    <h2>Teknisk tilstandsanalyse</h2>
    <dl class="kv">
      <dt>Objekt</dt><dd>${esc(s.meta.name)}</dd>
      <dt>Adresse</dt><dd>${esc(s.meta.address) || "–"}</dd>
      <dt>Befaringsdato</dt><dd>${date}</dd>
      <dt>Metode</dt><dd>Visuell tilstandsanalyse iht. NS 3424, nivå 1, AI-assistert bildeanalyse</dd>
      <dt>Referanser</dt><dd>NS 3424, NS 3451, NS 3454 / Byggforskserien</dd>
    </dl>
    ${s.meta.info ? `<h3>Opplysninger</h3><p>${esc(s.meta.info)}</p>` : ""}
    <p class="disclaimer">Rapporten er utarbeidet med AI-assistert bildeanalyse og er ikke en
    fullverdig erstatning for fysisk befaring av kvalifisert takstmann. Skjulte konstruksjoner,
    ikke-fotograferte arealer og forhold som krever måling eller åpning av konstruksjon er ikke vurdert.</p>
  </div>`;
  if (!s.buildingAnalysis && !s.componentAnalysis && !s.actionPlan) {
    html += '<div class="card"><p class="hint">Kjør analysene under fanene Bygning, Komponenter og Tiltaksplan for å fylle rapporten.</p></div>';
  }
  html += buildingHtml(s.buildingAnalysis);
  html += componentsHtml(s.componentAnalysis);
  html += planHtml(s.actionPlan);
  return html;
}

$("#printBtn").addEventListener("click", () => window.print());

// --- Render ------------------------------------------------------------------------

function renderAll() {
  renderPhotos();
  $("#buildingResult").innerHTML = buildingHtml(current.buildingAnalysis);
  $("#componentsResult").innerHTML = componentsHtml(current.componentAnalysis);
  $("#planResult").innerHTML = planHtml(current.actionPlan);
  $("#reportResult").innerHTML = reportHtml();
}

// --- Init --------------------------------------------------------------------------

(async () => {
  try {
    const health = await api("GET", "/api/health");
    if (!health.apiKey) toast("ANTHROPIC_API_KEY er ikke satt på serveren – AI-analyse er deaktivert.");
  } catch { /* ignorer */ }
  showList();
})();
