# Tilstandsanalyse – AI-assistert teknisk tilstandsvurdering

Mobilvennlig webapplikasjon for tekniske tilstandsanalyser av bygninger på befaring,
tungt assistert av AI (Claude med bildeanalyse).

## Hva appen gjør

1. **Befaring med mobilkamera** – ta bilder av bygningen utvendig og innvendig, rom for rom.
2. **Bygningsanalyse (eksteriør)** – AI beskriver byggemetode, fasadetype, takform og tekking,
   dekker, fundamentering og vinduer, og anslår **byggeperiode** basert på stiltrekk og norsk byggeskikk.
3. **Komponentanalyse (interiør)** – AI identifiserer alle relevante bygningsdeler og bygger en
   komponenttabell etter **NS 3451 (bygningsdelstabellen)** med:
   - tilstandsgrad etter **NS 3424** (TG0–TG3 / TGIU) med begrunnelse,
   - antatt alder, forventet levetid (Byggforsk-intervaller) og gjenværende levetid,
   - registrerte skader og avvik.
4. **Tiltaksplan** – AI genererer tiltak (strakstiltak, utbedring, utskifting, vedlikehold) med
   kostnadsoverslag i NOK, prioritet og foreslått oppstartsår, samt en **30-års vedlikeholds- og
   utskiftingsplan** med årlige kostnader.
5. **Rapport** – samlet tilstandsrapport som kan skrives ut / lagres som PDF fra mobilen.

## Kom i gang

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # API-nøkkel fra https://platform.claude.com
npm start
```

Åpne `http://localhost:3000` på mobilen (eller bruk f.eks. en tunnel/lokalt nett for
tilgang fra telefonen). Appen er laget mobil-først og bruker kameraet direkte via
filvelgeren (`capture="environment"`).

## Arkitektur

| Del | Beskrivelse |
|---|---|
| `server.js` | Express-server: befaringer, bildeopplasting, analyse-endepunkter |
| `lib/claude.js` | All AI-logikk: prompts, JSON-skjemaer (structured outputs) og kall mot Claude (`claude-opus-4-8`, adaptiv tenking, streaming) |
| `public/` | Mobil-først frontend (vanilla JS), klient-side nedskalering av bilder før opplasting |
| `data/` | Lokal lagring: én JSON-fil per befaring + bildefiler (ikke i git) |

### API

| Metode | Endepunkt | Beskrivelse |
|---|---|---|
| `POST` | `/api/surveys` | Opprett befaring |
| `GET` | `/api/surveys` / `/api/surveys/:id` | List / hent befaring |
| `POST` | `/api/surveys/:id/photos` | Last opp bilde (base64, kategori `eksterior`/`interior`) |
| `POST` | `/api/surveys/:id/analyze/building` | Bygningsanalyse av eksteriørbilder |
| `POST` | `/api/surveys/:id/analyze/components` | Komponenttabell av interiørbilder |
| `POST` | `/api/surveys/:id/plan` | Tiltaksplan + 30-årsplan |

## Viktige forbehold

- Resultatene er AI-genererte vurderinger basert på bilder, og erstatter ikke fysisk befaring
  av kvalifisert takstmann. Skjulte konstruksjoner og forhold som krever måling eller åpning
  vurderes ikke.
- Kostnader er grove erfaringsbaserte overslag inkl. mva. og må kvalitetssikres mot lokale priser.
