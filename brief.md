# Project Brief - ShouldWear

**ShouldWear** is a PWA (Progressive Web App) that uses real-time weather data to give a single, clear answer: *what should I wear right now?* It targets the daily use case of someone glancing at their phone before leaving the house.

The app auto-detects the user's location via the Geolocation API, with a fallback to a manually set custom location (tappable location icon). It then queries a **free weather API** (Open-Meteo is ideal - no API key required, free, accurate, includes hourly forecast) for current and hourly data across the next 12–24 hours.

The core output is a **three-tier clothing recommendation**: Hoodie / Light Jumper / T-Shirt only. Each tier has an **acceptance bar** - a horizontal indicator with a red→yellow→green gradient showing how suitable that option is right now. The rating algorithm accounts for:

- Current temperature and feels-like
- Wind chill
- Rain/precipitation probability
- Longitudinal time - how conditions change across the day (e.g., warm morning but rainy afternoon means a hoodie scores higher even if current temp is mild)

The app will be hosted on **GitHub Pages** with a custom domain `weather.nexusgit.info` and must be a valid installable PWA (manifest + service worker).

**Stack:** Vanilla JS or Preact (lightweight), CSS with design tokens, no build tools required, static HTML deployable to GitHub Pages.
