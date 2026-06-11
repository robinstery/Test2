"use strict";

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

const MODEL = "claude-opus-4-8";

// Felles fagkontekst for alle analysekall. Holdes stabil (ingen dynamisk
// innhold) slik at prompt-caching treffer på tvers av forespørsler.
const SYSTEM_PROMPT = `Du er en erfaren norsk takstmann og bygningsingeniør som utfører tekniske
tilstandsanalyser av bygninger i henhold til norske standarder:

- NS 3424 "Tilstandsanalyse av byggverk" – tilstandsgrader:
  - TG0: Ingen avvik. Komponenten er ny eller som ny, ingen symptomer.
  - TG1: Mindre avvik. Normal slitasje, jevnlig vedlikeholdt, ingen strakstiltak.
  - TG2: Vesentlige avvik. Sterkt nedslitt, vesentlig skade eller vesentlig redusert funksjon.
  - TG3: Store eller alvorlige avvik. Total funksjonssvikt, fare for liv og helse, akutt behov.
  - TGIU: Ikke undersøkt / ikke tilgjengelig for vurdering.
- NS 3451 "Bygningsdelstabell" – hovedinndeling:
  2 Bygning (21 Grunn og fundamenter, 22 Bæresystemer, 23 Yttervegger inkl. vinduer/ytterdører,
  24 Innervegger, 25 Dekker inkl. gulv og himling, 26 Yttertak, 27 Fast inventar,
  28 Trapper og balkonger), 3 VVS-installasjoner (31 Sanitær, 32 Varme, 33 Brannslokking,
  36 Luftbehandling), 4 Elkraft, 5 Tele og automatisering, 6 Andre installasjoner (62 Heis),
  7 Utendørs.
- NS 3454 "Livssykluskostnader" og Byggforskseriens intervaller for forventet levetid
  (eksempler: malt trekledning 30–60 år, takstein 30–60 år, papptekking 20–30 år,
  trevinduer 20–60 år, varmtvannsbereder 15–25 år, røropplegg kobber 30–50 år,
  elektrisk anlegg 30–50 år, våtrom membran 15–30 år, kjøkkeninnredning 20–30 år).

Du vurderer bygninger ut fra fotografier. Vær konkret og faglig nøktern. Når du er usikker,
si det eksplisitt og bruk konservative anslag. Datering av byggeår baseres på stiltrekk,
byggemetode, materialbruk, vindustyper, detaljer og typiske norske byggeskikker per tiår.
Alle kostnader oppgis i norske kroner (NOK) inkl. mva., basert på typisk norsk prisnivå for
håndverkertjenester. Kostnader er grove erfaringsbaserte overslag, ikke anbudspriser.
Svar alltid på norsk bokmål.`;

// --- JSON-skjemaer for strukturert utdata -------------------------------

const BUILDING_SCHEMA = {
  type: "object",
  properties: {
    bygningstype: { type: "string", description: "F.eks. enebolig, tomannsbolig, leilighetsbygg, næringsbygg" },
    byggeaar: {
      type: "object",
      properties: {
        estimat: { type: "integer", description: "Mest sannsynlige byggeår" },
        fra: { type: "integer" },
        til: { type: "integer" },
        begrunnelse: { type: "string", description: "Stiltrekk og detaljer som ligger til grunn for dateringen" }
      },
      required: ["estimat", "fra", "til", "begrunnelse"],
      additionalProperties: false
    },
    byggemetode: { type: "string", description: "Konstruksjonsprinsipp, f.eks. bindingsverk i tre, plasstøpt betong, murverk" },
    etasjer: { type: "integer" },
    fundamentering: { type: "string" },
    fasade: {
      type: "object",
      properties: {
        type: { type: "string" },
        materiale: { type: "string" },
        beskrivelse: { type: "string" }
      },
      required: ["type", "materiale", "beskrivelse"],
      additionalProperties: false
    },
    tak: {
      type: "object",
      properties: {
        takform: { type: "string", description: "F.eks. saltak, valmtak, pulttak, flatt tak" },
        tekking: { type: "string", description: "F.eks. betongtakstein, stålplater, papp" },
        beskrivelse: { type: "string" }
      },
      required: ["takform", "tekking", "beskrivelse"],
      additionalProperties: false
    },
    dekker: { type: "string", description: "Antatt dekkekonstruksjon, f.eks. trebjelkelag, betongdekker" },
    vinduer: { type: "string", description: "Vindustype og antatt alder/generasjon" },
    helhetsinntrykk: { type: "string", description: "Kort samlet vurdering av bygningen" },
    observasjoner: {
      type: "array",
      items: { type: "string" },
      description: "Konkrete observasjoner fra bildene, inkl. mulige avvik"
    },
    usikkerhet: { type: "string", description: "Hva analysen er usikker på og hva som bør undersøkes nærmere" }
  },
  required: ["bygningstype", "byggeaar", "byggemetode", "etasjer", "fundamentering", "fasade", "tak", "dekker", "vinduer", "helhetsinntrykk", "observasjoner", "usikkerhet"],
  additionalProperties: false
};

const COMPONENTS_SCHEMA = {
  type: "object",
  properties: {
    komponenter: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ns3451: { type: "string", description: "Tosifret kode fra bygningsdelstabellen, f.eks. '23'" },
          ns3451Navn: { type: "string", description: "Navn på bygningsdel, f.eks. 'Yttervegger'" },
          komponent: { type: "string", description: "Konkret komponent, f.eks. 'Trevinduer stue'" },
          plassering: { type: "string", description: "Hvor i bygningen komponenten er observert" },
          materiale: { type: "string" },
          tilstandsgrad: { type: "string", enum: ["TG0", "TG1", "TG2", "TG3", "TGIU"] },
          tilstandsbeskrivelse: { type: "string", description: "Begrunnelse for tilstandsgraden, observerte symptomer og avvik" },
          antattAlder: { type: "integer", description: "Antatt alder i år" },
          forventetLevetid: { type: "integer", description: "Normal forventet levetid i år for denne komponenttypen" },
          gjenvaerendeLevetid: { type: "integer", description: "Anslått gjenværende levetid i år" },
          skader: {
            type: "array",
            items: { type: "string" },
            description: "Registrerte skader eller avvik. Tom liste hvis ingen."
          }
        },
        required: ["ns3451", "ns3451Navn", "komponent", "plassering", "materiale", "tilstandsgrad", "tilstandsbeskrivelse", "antattAlder", "forventetLevetid", "gjenvaerendeLevetid", "skader"],
        additionalProperties: false
      }
    },
    generellVurdering: { type: "string", description: "Samlet vurdering av tilstanden på de analyserte komponentene" }
  },
  required: ["komponenter", "generellVurdering"],
  additionalProperties: false
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    tiltak: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          ns3451: { type: "string" },
          komponent: { type: "string" },
          beskrivelse: { type: "string", description: "Hva tiltaket går ut på" },
          type: { type: "string", enum: ["strakstiltak", "utbedring", "utskifting", "vedlikehold", "videre undersøkelse"] },
          prioritet: { type: "integer", description: "1 = høyest (TG3/HMS), 2 = middels (TG2), 3 = lav (TG1/forebyggende)" },
          kostnadNOK: {
            type: "object",
            properties: {
              lav: { type: "integer" },
              forventet: { type: "integer" },
              hoey: { type: "integer" }
            },
            required: ["lav", "forventet", "hoey"],
            additionalProperties: false
          },
          startAar: { type: "integer", description: "Foreslått oppstartsår" },
          intervallAar: { type: "integer", description: "Gjentaksintervall i år for periodisk vedlikehold. 0 hvis engangstiltak." },
          begrunnelse: { type: "string" }
        },
        required: ["id", "ns3451", "komponent", "beskrivelse", "type", "prioritet", "kostnadNOK", "startAar", "intervallAar", "begrunnelse"],
        additionalProperties: false
      }
    },
    trettiaarsplan: {
      type: "array",
      description: "Ett innslag per år i 30-årsperioden som har planlagte tiltak",
      items: {
        type: "object",
        properties: {
          aar: { type: "integer" },
          tiltakIder: { type: "array", items: { type: "integer" } },
          sumNOK: { type: "integer" }
        },
        required: ["aar", "tiltakIder", "sumNOK"],
        additionalProperties: false
      }
    },
    oppsummering: {
      type: "object",
      properties: {
        strakstiltakNOK: { type: "integer", description: "Sum tiltak som bør utføres innen 1 år" },
        foersteFemAarNOK: { type: "integer" },
        totaltTrettiAarNOK: { type: "integer" },
        aarligGjennomsnittNOK: { type: "integer" },
        hovedkonklusjon: { type: "string", description: "Samlet konklusjon om bygningens tilstand og vedlikeholdsbehov" }
      },
      required: ["strakstiltakNOK", "foersteFemAarNOK", "totaltTrettiAarNOK", "aarligGjennomsnittNOK", "hovedkonklusjon"],
      additionalProperties: false
    }
  },
  required: ["tiltak", "trettiaarsplan", "oppsummering"],
  additionalProperties: false
};

// --- Hjelpere ------------------------------------------------------------

function imageBlocks(photos) {
  return photos.flatMap((p, i) => {
    const blocks = [
      {
        type: "image",
        source: { type: "base64", media_type: p.mediaType, data: p.data }
      }
    ];
    const label = `Bilde ${i + 1}${p.note ? ": " + p.note : ""}`;
    blocks.push({ type: "text", text: label });
    return blocks;
  });
}

async function structuredRequest(content, schema, maxTokens) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }
    ],
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }]
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("Forespørselen ble avvist av modellen.");
  }
  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error("Tomt svar fra modellen (stop_reason: " + message.stop_reason + ").");
  }
  return JSON.parse(textBlock.text);
}

// --- Analysefunksjoner ----------------------------------------------------

/**
 * Analyserer eksteriørbilder: byggemetode, fasade, tak, dekker,
 * grunndata og antatt byggeperiode.
 */
async function analyzeBuilding(photos, surveyInfo) {
  const content = [
    ...imageBlocks(photos),
    {
      type: "text",
      text: `Dette er eksteriørbilder av en bygning som skal tilstandsvurderes.
${surveyInfo ? "Opplysninger fra befaringen: " + surveyInfo : ""}

Analyser bildene og beskriv bygningen: bygningstype, byggemetode/konstruksjonsprinsipp,
fasadetype og -materiale, takform og tekking, antatt dekkekonstruksjon, fundamentering,
vinduer og antall etasjer. Anslå byggeår/byggeperiode basert på stiltrekk og byggeskikk,
med begrunnelse. List konkrete observasjoner, inkludert synlige avvik eller skader.`
    }
  ];
  return structuredRequest(content, BUILDING_SCHEMA, 16000);
}

/**
 * Analyserer interiørbilder (og ev. detaljbilder utvendig) og bygger
 * komponenttabell etter NS 3451 med tilstandsgrad etter NS 3424,
 * antatt alder og forventet levetid.
 */
async function analyzeComponents(photos, surveyInfo, buildingAnalysis) {
  const contextText = buildingAnalysis
    ? `Bygningen er tidligere vurdert slik: ${buildingAnalysis.bygningstype}, antatt byggeår ${buildingAnalysis.byggeaar.estimat} (${buildingAnalysis.byggeaar.fra}–${buildingAnalysis.byggeaar.til}), ${buildingAnalysis.byggemetode}. Bruk dette som utgangspunkt for aldersvurdering av komponenter, men juster der bildene tyder på senere oppgradering.`
    : "";
  const content = [
    ...imageBlocks(photos),
    {
      type: "text",
      text: `Dette er bilder fra befaring av bygningen (hovedsakelig interiør).
${contextText}
${surveyInfo ? "Opplysninger fra befaringen: " + surveyInfo : ""}

Identifiser alle relevante bygningsdeler og komponenter du kan vurdere ut fra bildene,
og klassifiser dem etter NS 3451 (bygningsdelstabellen). For hver komponent:
- Sett tilstandsgrad etter NS 3424 (TG0–TG3, eller TGIU der bildene ikke gir grunnlag).
- Begrunn tilstandsgraden med konkrete observasjoner.
- Anslå komponentens alder, normal forventet levetid for komponenttypen (Byggforsk-intervaller),
  og gjenværende levetid.
- List registrerte skader/avvik.
Vær systematisk og dekk alt som er synlig: overflater, vinduer/dører, kjøkken, bad/våtrom,
tekniske installasjoner (elektro, rør, ventilasjon, varme) der de er synlige.`
    }
  ];
  return structuredRequest(content, COMPONENTS_SCHEMA, 32000);
}

/**
 * Genererer tiltaksplan med kostnader og 30-års vedlikeholds- og utskiftingsplan
 * basert på bygningsanalyse og komponenttabell.
 */
async function generateActionPlan(survey, currentYear) {
  const content = [
    {
      type: "text",
      text: `Lag en komplett tiltaksplan og en 30-års vedlikeholds- og utskiftingsplan for
bygningen under, slik at den bringes opp til og holdes på et akseptabelt nivå (minimum TG1).
Inneværende år er ${currentYear}; planperioden er ${currentYear}–${currentYear + 29}.

Regler:
- TG3 gir strakstiltak (startår ${currentYear}, prioritet 1).
- TG2 gir utbedring/utskifting innen 1–5 år (prioritet 2).
- TG1 gir vedlikehold eller utskifting når gjenværende levetid løper ut (prioritet 3).
- Komponenter som når slutten av forventet levetid i planperioden, skal ha utskiftingstiltak
  i riktig år – også TG0/TG1-komponenter.
- Legg inn periodisk vedlikehold med fornuftige intervaller (f.eks. utvendig maling).
- Kostnader i NOK inkl. mva. (lavt/forventet/høyt overslag) på norsk prisnivå.
- Bygg 30-årsplanen ved å plassere tiltakene (inkl. gjentak av periodiske tiltak) på år,
  med årlig sum.

BYGNINGSDATA:
${JSON.stringify(survey.meta || {}, null, 2)}

BYGNINGSANALYSE:
${JSON.stringify(survey.buildingAnalysis, null, 2)}

KOMPONENTTABELL:
${JSON.stringify(survey.componentAnalysis, null, 2)}`
    }
  ];
  return structuredRequest(content, PLAN_SCHEMA, 48000);
}

module.exports = { analyzeBuilding, analyzeComponents, generateActionPlan };
