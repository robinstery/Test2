"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { analyzeBuilding, analyzeComponents, generateActionPlan } = require("./lib/claude");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const SURVEYS_DIR = path.join(DATA_DIR, "surveys");
const PHOTOS_DIR = path.join(DATA_DIR, "photos");

fs.mkdirSync(SURVEYS_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Lagring --------------------------------------------------------------

function surveyPath(id) {
  return path.join(SURVEYS_DIR, id + ".json");
}

function loadSurvey(id) {
  if (!/^[a-f0-9]{16}$/.test(id)) return null;
  const p = surveyPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveSurvey(survey) {
  fs.writeFileSync(surveyPath(survey.id), JSON.stringify(survey, null, 2));
}

function photoFile(surveyId, photoId, ext) {
  return path.join(PHOTOS_DIR, surveyId, photoId + "." + ext);
}

function loadPhotosForClaude(survey, category) {
  return survey.photos
    .filter((p) => p.category === category)
    .map((p) => ({
      data: fs.readFileSync(photoFile(survey.id, p.id, p.ext)).toString("base64"),
      mediaType: p.mediaType,
      note: p.note
    }));
}

// --- Befaringer -----------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post("/api/surveys", (req, res) => {
  const { name, address, info } = req.body || {};
  if (!name) return res.status(400).json({ error: "Navn på befaring mangler." });
  const survey = {
    id: crypto.randomBytes(8).toString("hex"),
    createdAt: new Date().toISOString(),
    meta: { name, address: address || "", info: info || "" },
    photos: [],
    buildingAnalysis: null,
    componentAnalysis: null,
    actionPlan: null
  };
  saveSurvey(survey);
  res.json(survey);
});

app.get("/api/surveys", (req, res) => {
  const surveys = fs
    .readdirSync(SURVEYS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SURVEYS_DIR, f), "utf8")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      meta: s.meta,
      photoCount: s.photos.length,
      hasBuilding: Boolean(s.buildingAnalysis),
      hasComponents: Boolean(s.componentAnalysis),
      hasPlan: Boolean(s.actionPlan)
    }));
  res.json(surveys);
});

app.get("/api/surveys/:id", (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  res.json(survey);
});

app.delete("/api/surveys/:id", (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  fs.rmSync(surveyPath(survey.id));
  fs.rmSync(path.join(PHOTOS_DIR, survey.id), { recursive: true, force: true });
  res.json({ ok: true });
});

// --- Bilder ----------------------------------------------------------------

const MEDIA_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

app.post("/api/surveys/:id/photos", (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  const { category, note, data, mediaType } = req.body || {};
  if (!["eksterior", "interior"].includes(category)) {
    return res.status(400).json({ error: "Kategori må være 'eksterior' eller 'interior'." });
  }
  const ext = MEDIA_EXT[mediaType];
  if (!ext) return res.status(400).json({ error: "Ustøttet bildeformat: " + mediaType });
  if (!data) return res.status(400).json({ error: "Bildedata mangler." });

  const photo = {
    id: crypto.randomBytes(8).toString("hex"),
    category,
    note: note || "",
    mediaType,
    ext,
    createdAt: new Date().toISOString()
  };
  fs.mkdirSync(path.join(PHOTOS_DIR, survey.id), { recursive: true });
  fs.writeFileSync(photoFile(survey.id, photo.id, ext), Buffer.from(data, "base64"));
  survey.photos.push(photo);
  saveSurvey(survey);
  res.json(photo);
});

app.delete("/api/surveys/:id/photos/:photoId", (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  const photo = survey.photos.find((p) => p.id === req.params.photoId);
  if (!photo) return res.status(404).json({ error: "Bilde ikke funnet." });
  fs.rmSync(photoFile(survey.id, photo.id, photo.ext), { force: true });
  survey.photos = survey.photos.filter((p) => p.id !== photo.id);
  saveSurvey(survey);
  res.json({ ok: true });
});

app.get("/photos/:surveyId/:photoId", (req, res) => {
  const survey = loadSurvey(req.params.surveyId);
  if (!survey) return res.status(404).end();
  const photo = survey.photos.find((p) => p.id === req.params.photoId);
  if (!photo) return res.status(404).end();
  res.type(photo.mediaType).sendFile(photoFile(survey.id, photo.id, photo.ext));
});

// --- AI-analyse -------------------------------------------------------------

function requireApiKey(res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: "ANTHROPIC_API_KEY er ikke satt på serveren. Sett miljøvariabelen og start på nytt."
    });
    return false;
  }
  return true;
}

app.post("/api/surveys/:id/analyze/building", async (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  if (!requireApiKey(res)) return;
  const photos = loadPhotosForClaude(survey, "eksterior");
  if (photos.length === 0) {
    return res.status(400).json({ error: "Last opp minst ett eksteriørbilde først." });
  }
  try {
    survey.buildingAnalysis = await analyzeBuilding(photos, survey.meta.info);
    survey.actionPlan = null; // grunnlaget er endret
    saveSurvey(survey);
    res.json(survey.buildingAnalysis);
  } catch (err) {
    console.error("Bygningsanalyse feilet:", err);
    res.status(502).json({ error: "Bygningsanalysen feilet: " + err.message });
  }
});

app.post("/api/surveys/:id/analyze/components", async (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  if (!requireApiKey(res)) return;
  const photos = loadPhotosForClaude(survey, "interior");
  if (photos.length === 0) {
    return res.status(400).json({ error: "Last opp minst ett interiørbilde først." });
  }
  try {
    survey.componentAnalysis = await analyzeComponents(photos, survey.meta.info, survey.buildingAnalysis);
    survey.actionPlan = null; // grunnlaget er endret
    saveSurvey(survey);
    res.json(survey.componentAnalysis);
  } catch (err) {
    console.error("Komponentanalyse feilet:", err);
    res.status(502).json({ error: "Komponentanalysen feilet: " + err.message });
  }
});

app.post("/api/surveys/:id/plan", async (req, res) => {
  const survey = loadSurvey(req.params.id);
  if (!survey) return res.status(404).json({ error: "Befaring ikke funnet." });
  if (!requireApiKey(res)) return;
  if (!survey.componentAnalysis) {
    return res.status(400).json({ error: "Kjør komponentanalysen før tiltaksplanen genereres." });
  }
  try {
    survey.actionPlan = await generateActionPlan(survey, new Date().getFullYear());
    saveSurvey(survey);
    res.json(survey.actionPlan);
  } catch (err) {
    console.error("Tiltaksplan feilet:", err);
    res.status(502).json({ error: "Generering av tiltaksplan feilet: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Tilstandsanalyse kjører på http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("ADVARSEL: ANTHROPIC_API_KEY er ikke satt – AI-analyse vil ikke fungere.");
  }
});
