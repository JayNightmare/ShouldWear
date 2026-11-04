"use strict";

const {
	FORECAST_HOURS,
	CLOTHING_TIERS,
	calculateTierScores,
	comfortToOffset,
	sanitizeComfort,
	createStorage,
	debounce,
	findPrecipitationAlerts,
	formatTimestamp,
	getFootwearAdvice,
	loadSettings,
	loadWeatherCache,
	normalizeWeatherResponse,
	saveSettings,
	saveWeatherCache,
	selectTopTier,
	toFiniteNumber,
	sanitizeSettings,
	DEFAULT_LABELS,
} = window.ShouldWearCore;

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_API_URL = "https://nominatim.openstreetmap.org";
const API_TIMEOUT_MS = 8000;
const SEARCH_DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;
const SHORT_TRIP_MAX_HOURS = 4;
const SHORT_TRIP_DEFAULT_HOURS = 4;
const LONG_TRIP_DEFAULT_HOURS = 8;

const storage = createStorage(() => window.localStorage);

const state = {
	settings: loadSettings(storage),
	forecastHours: SHORT_TRIP_DEFAULT_HOURS,
	location: null,
	locationRevision: 0,
	searchResults: [],
	topTier: null,
	weather: null,
	fetchedAt: null,
	fromCache: false,
};

const elements = {};
const tierRefs = new Map();
let forecastRefs = [];
let searchController = null;
let lastQuery = "";
const searchCache = new Map();

/* ---------- small DOM helpers ---------- */

function setText(node, text) {
	if (node.textContent !== text) {
		node.textContent = text;
	}
}

function setAppStatus(message) {
	setText(elements.status, message);
}

function persistSettings() {
	state.settings = saveSettings(storage, state.settings);
}

/* ---------- weather descriptors ---------- */

function getWeatherDescriptor(code) {
	if (code === 0) {
		return { icon: "\u2600", label: "Clear" };
	}
	if (code <= 2) {
		return { icon: "\u25D2", label: "Partly cloudy" };
	}
	if (code === 3) {
		return { icon: "\u2601", label: "Overcast" };
	}
	if (code === 45 || code === 48) {
		return { icon: "\u224B", label: "Foggy" };
	}
	if (code >= 51 && code <= 57) {
		return { icon: "\u2614", label: "Drizzle" };
	}
	if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) {
		return { icon: "\u2614", label: "Rain" };
	}
	if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
		return { icon: "\u2744", label: "Snow" };
	}
	if (code >= 95) {
		return { icon: "\u26A1", label: "Thunderstorms" };
	}
	return { icon: "\u25CB", label: "Variable" };
}

function buildWeatherUrl(location) {
	const parameters = new URLSearchParams({
		latitude: location.latitude.toFixed(4),
		longitude: location.longitude.toFixed(4),
		current: "temperature_2m,apparent_temperature,precipitation,wind_speed_10m,weather_code",
		hourly: "temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,weather_code",
		forecast_days: "2",
		past_days: "7",
		timezone: "auto",
	});
	return `${WEATHER_API_URL}?${parameters.toString()}`;
}

/* ---------- network ---------- */

// Resolves { data, cachedAt }; cachedAt is set when the service worker served a stored copy.
async function requestJson(url, { signal, timeoutMs = API_TIMEOUT_MS } = {}) {
	const controller = new AbortController();
	let timedOut = false;
	const timeout = window.setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const forwardAbort = () => controller.abort();
	signal?.addEventListener("abort", forwardAbort, { once: true });

	try {
		const response = await fetch(url, {
			headers: { Accept: "application/json" },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`Request failed with status ${response.status}.`,
			);
		}
		const cachedAt = Number(response.headers.get("x-sw-cached-at"));
		return {
			data: await response.json(),
			cachedAt:
				Number.isFinite(cachedAt) && cachedAt > 0
					? cachedAt
					: null,
		};
	} catch (error) {
		if (error.name === "AbortError" && timedOut) {
			throw new Error(
				"The request took too long. Please try again.",
			);
		}
		throw error;
	} finally {
		window.clearTimeout(timeout);
		signal?.removeEventListener("abort", forwardAbort);
	}
}

/* ---------- skeleton / loading / error views ---------- */

function createSkeletonTiers() {
	return CLOTHING_TIERS.map(() => {
		const item = document.createElement("article");
		item.className = "tier-item skeleton-card";
		item.setAttribute("aria-hidden", "true");
		item.innerHTML =
			'<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-bar"></div>';
		return item;
	});
}

function createSkeletonHours() {
	return Array.from({ length: 8 }, () => {
		const item = document.createElement("li");
		item.className = "forecast-hour skeleton-card";
		item.setAttribute("aria-hidden", "true");
		item.innerHTML =
			'<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-dot"></div><div class="skeleton skeleton-line"></div>';
		return item;
	});
}

function renderLoading(message = "Reading the forecast...") {
	state.topTier = null;
	document.body.dataset.view = "loading";
	elements.retryButton.hidden = true;
	setText(elements.heroEyebrow, "Forecast in progress");
	setText(elements.heroTitle, "Looking outside");
	setText(elements.heroScore, "--");
	setText(elements.heroScoreLabel, "acceptance");
	setText(elements.heroReason, message);
	["currentTemperature", "currentFeelsLike"].forEach((key) =>
		setText(elements[key], "--\u00B0"),
	);
	setText(elements.currentCondition, "--");
	setText(elements.currentWind, "-- km/h");
	setText(elements.currentRain, "-- mm");
	[
		elements.trendTemperature,
		elements.trendFeelsLike,
		elements.trendWind,
		elements.trendRain,
	].forEach((node) => delete node.dataset.trend);
	elements.offlineBadge.hidden = true;
	elements.alerts.hidden = true;
	tierRefs.clear();
	forecastRefs = [];
	elements.tierList.replaceChildren(...createSkeletonTiers());
	elements.forecastList.replaceChildren(...createSkeletonHours());
	elements.locationName.classList.toggle(
		"skeleton-text",
		!state.location,
	);
	setAppStatus(message);
}

function renderError(message) {
	document.body.dataset.view = "error";
	state.topTier = null;
	setText(elements.heroEyebrow, "Forecast unavailable");
	setText(elements.heroTitle, "No answer yet");
	setText(elements.heroScore, "--");
	setText(elements.heroScoreLabel, "acceptance");
	setText(elements.heroReason, message);
	elements.retryButton.hidden = false;
	elements.alerts.hidden = true;
	elements.tierList.replaceChildren();
	elements.forecastList.replaceChildren();
	tierRefs.clear();
	forecastRefs = [];
	elements.locationName.classList.remove("skeleton-text");
	setAppStatus(message);
}

function renderChooseLocation(message) {
	renderError(message);
	setText(elements.heroEyebrow, "Pick a location");
	setText(elements.heroTitle, "Where are you?");
	elements.retryButton.hidden = true;
	setText(elements.locationName, "Choose location");
}

/* ---------- recommendation rendering (in-place) ---------- */

function isLongTrip() {
	return state.forecastHours > SHORT_TRIP_MAX_HOURS;
}

function getScoringOptions() {
	const { settings } = state;
	return {
		forecastHours: state.forecastHours,
		exposure: isLongTrip() ? "long" : "short",
		thermalOffset: comfortToOffset(settings.comfort),
		labels: settings.labels,
		available: settings.available,
	};
}

function formatForecastWindow(forecastHours) {
	return forecastHours === 1
		? "the next hour"
		: `the next ${forecastHours} hours`;
}

// Each "+" is one extra layer worn underneath, shown muted after the name.
function setTierName(node, tier) {
	const layers = tier.layers ?? 0;
	const nodes = [tier.label];
	if (layers > 0) {
		const plus = document.createElement("span");
		plus.className = "layers";
		plus.textContent = "+".repeat(layers);
		plus.setAttribute(
			"aria-label",
			`${layers} extra layer${layers === 1 ? "" : "s"} underneath`,
		);
		nodes.push(plus);
	}
	node.replaceChildren(...nodes);
}

function getRecommendationReason(hours, rainRisk, alerts, layers = 0) {
	const windowLabel = formatForecastWindow(hours.length);
	if (layers > 0) {
		return `Cold enough to add ${layers === 1 ? "a layer" : `${layers} layers`} underneath.`;
	}
	if (alerts.length > 0) {
		return `${alerts[0].message}.`;
	}
	if (rainRisk) {
		return "Rain is possible early on.";
	}
	const strongestWind = Math.max(...hours.map((hour) => hour.windSpeed));
	const change = hours[hours.length - 1].feelsLike - hours[0].feelsLike;
	if (strongestWind > 20) {
		return `Wind reaches ${Math.round(strongestWind)} km/h in ${windowLabel}.`;
	}
	if (change <= -4) {
		return `It will feel noticeably cooler by the end of ${windowLabel}.`;
	}
	if (change >= 4) {
		return `It will feel noticeably warmer by the end of ${windowLabel}.`;
	}
	return `Conditions stay fairly steady for ${windowLabel}.`;
}

function createTierRefs(tier) {
	const root = document.createElement("article");
	root.className = "tier-item";
	root.dataset.tier = tier.id;

	const heading = document.createElement("div");
	heading.className = "tier-heading";
	const name = document.createElement("h3");
	const value = document.createElement("span");
	value.className = "tier-value mono";
	heading.append(name, value);

	const wrap = document.createElement("div");
	wrap.className = "bar-wrap";
	wrap.style.setProperty("--score", "0%");
	const bar = document.createElement("div");
	bar.className = "acceptance-bar";
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	const fill = document.createElement("span");
	fill.className = "acceptance-fill";
	bar.append(fill);
	wrap.append(bar);

	root.append(heading, wrap);
	return { root, name, value, wrap, bar };
}

function updateTier(refs, tier, isTop) {
	setTierName(refs.name, tier);
	setText(refs.value, `${tier.score}%`);
	refs.root.classList.toggle("tier-item--recommended", isTop);
	refs.bar.setAttribute("aria-label", `${tier.label} acceptance`);
	refs.bar.setAttribute("aria-valuenow", String(tier.score));
	refs.wrap.style.setProperty("--score", `${tier.score}%`);
}

function renderTiers(scores, topTier) {
	if (
		tierRefs.size !== scores.length ||
		scores.some((tier) => !tierRefs.has(tier.id))
	) {
		tierRefs.clear();
		const created = scores.map((tier) => {
			const refs = createTierRefs(tier);
			tierRefs.set(tier.id, refs);
			return refs;
		});
		elements.tierList.replaceChildren(
			...created.map((refs) => refs.root),
		);
		// Bars start at 0 and grow on the next frames so the CSS transition runs.
		window.requestAnimationFrame(() =>
			window.requestAnimationFrame(() =>
				scores.forEach((tier) =>
					updateTier(
						tierRefs.get(tier.id),
						tier,
						tier.id === topTier.id,
					),
				),
			),
		);
		scores.forEach((tier) => {
			const refs = tierRefs.get(tier.id);
			setTierName(refs.name, tier);
			setText(refs.value, `${tier.score}%`);
		});
		return;
	}
	scores.forEach((tier) =>
		updateTier(tierRefs.get(tier.id), tier, tier.id === topTier.id),
	);
}

function renderAlerts(alerts) {
	const footwear = getFootwearAdvice(alerts);
	elements.alerts.hidden = alerts.length === 0;

	const items = alerts.map((alert) => {
		const item = document.createElement("li");
		item.className = `alert-item alert-item--${alert.severity}`;
		const text = document.createElement("span");
		text.textContent = alert.message;
		item.append(text);
		return item;
	});
	elements.alertList.replaceChildren(...items);

	elements.footwear.hidden = !footwear;
	if (footwear) {
		setText(elements.footwearTitle, `Wear: ${footwear.recommend}`);
		setText(
			elements.footwearDetail,
			`Avoid: ${footwear.avoid} \u00B7 ${footwear.window}`,
		);
	}
}

function updateForecastWindowMarks(windowHours) {
	const times = new Set(windowHours.map((hour) => hour.time));
	forecastRefs.forEach(({ item, time }) =>
		item.classList.toggle("forecast-hour--out", times.has(time)),
	);
}

function getVisualSeason(topTier, hours) {
	if (topTier.id === "shirt") {
		return "summer";
	}
	if (topTier.id === "jumper") {
		return "spring";
	}

	const apparentTemperatures = hours
		.map((hour) => hour.feelsLike ?? hour.temperature)
		.filter(Number.isFinite);
	const averageTemperature = apparentTemperatures.length
		? apparentTemperatures.reduce(
				(total, temperature) => total + temperature,
				0,
			) / apparentTemperatures.length
		: 8;
	return averageTemperature <= 8 ? "winter" : "autumn";
}

function renderRecommendation() {
	if (!state.weather) {
		return;
	}
	const {
		hours,
		rainRisk,
		scores: allScores,
	} = calculateTierScores(state.weather.hourly, getScoringOptions());
	const scores = allScores.filter(
		(tier) => state.settings.available[tier.id],
	);
	const alerts = findPrecipitationAlerts(hours);
	const topTier = selectTopTier(scores);
	const previousTop = state.topTier;
	state.topTier = topTier;

	document.body.dataset.view = "ready";
	document.body.dataset.recommendation = topTier.id;
	document.body.dataset.visualSeason = getVisualSeason(topTier, hours);
	elements.retryButton.hidden = true;
	setText(elements.heroEyebrow, "Top recommendation");
	setTierName(elements.heroTitle, topTier);
	setText(elements.heroScore, String(topTier.score));
	setText(elements.heroScoreLabel, `% ${topTier.label}`);
	setText(
		elements.heroReason,
		getRecommendationReason(
			hours,
			rainRisk,
			alerts,
			topTier.layers,
		),
	);

	elements.forecastHours.value = String(state.forecastHours);

	renderTiers(scores, topTier);
	renderAlerts(alerts);
	updateForecastWindowMarks(hours);
	updateStepperSummary();

	if (
		!previousTop ||
		previousTop.id !== topTier.id ||
		previousTop.label !== topTier.label ||
		previousTop.layers !== topTier.layers
	) {
		setAppStatus(
			`For ${state.location?.label ?? "your location"}, ${topTier.label}${topTier.layers ? ` with ${topTier.layers} extra layer${topTier.layers === 1 ? "" : "s"} underneath` : ""} is the top recommendation, with ${topTier.score} percent acceptance.`,
		);
	}
}

function formatHour(isoTime) {
	const hour = Number(isoTime.slice(11, 13));
	return `${hour % 12 || 12}${hour < 12 ? "am" : "pm"}`;
}

function createForecastElement(hour, index) {
	const descriptor = getWeatherDescriptor(hour.weatherCode);
	const item = document.createElement("li");
	item.className = "forecast-hour";

	const time = document.createElement("time");
	time.dateTime = hour.time;
	time.className = "mono";
	time.textContent = index === 0 ? "Now" : formatHour(hour.time);

	const icon = document.createElement("span");
	icon.className = "forecast-icon";
	icon.setAttribute("role", "img");
	icon.setAttribute("aria-label", descriptor.label);
	icon.textContent = descriptor.icon;

	const temperature = document.createElement("strong");
	temperature.className = "mono";
	temperature.textContent = `${Math.round(hour.temperature)}\u00B0`;

	const rain = document.createElement("span");
	rain.className = "forecast-rain mono";
	rain.textContent = `${Math.round(hour.precipitationProbability)}%`;
	rain.setAttribute(
		"aria-label",
		`${Math.round(hour.precipitationProbability)} percent chance of rain`,
	);

	item.append(time, icon, temperature, rain);
	return item;
}

function renderBadge() {
	const show = state.fromCache && state.fetchedAt;
	elements.offlineBadge.hidden = !show;
	if (show) {
		setText(
			elements.offlineBadge,
			`Last updated at ${formatTimestamp(state.fetchedAt)}`,
		);
	}
}

function renderWeather(weather, { fetchedAt, fromCache }) {
	state.weather = weather;
	state.fetchedAt = fetchedAt;
	state.fromCache = fromCache;

	const current = weather.current;
	setText(
		elements.currentCondition,
		getWeatherDescriptor(current.weatherCode).label,
	);
	setText(
		elements.currentTemperature,
		`${Math.round(current.temperature)}\u00B0`,
	);
	setText(
		elements.currentFeelsLike,
		`${Math.round(current.feelsLike)}\u00B0`,
	);
	setText(elements.currentWind, `${Math.round(current.windSpeed)} km/h`);
	setText(elements.currentRain, `${current.precipitation.toFixed(1)} mm`);
	renderTrend(
		elements.trendTemperature,
		"temperature",
		current.temperature,
	);
	renderTrend(elements.trendFeelsLike, "feelsLike", current.feelsLike);
	renderTrend(elements.trendWind, "windSpeed", current.windSpeed);
	renderTrend(elements.trendRain, "precipitation", current.precipitation);

	const shown = weather.hourly.slice(0, FORECAST_HOURS);
	forecastRefs = shown.map((hour, index) => ({
		item: createForecastElement(hour, index),
		time: hour.time,
	}));
	elements.forecastList.replaceChildren(
		...forecastRefs.map((ref) => ref.item),
	);
	elements.locationName.classList.remove("skeleton-text");

	tierRefs.clear();
	renderRecommendation();
	renderBadge();
	renderComfortQuestion();
}

/* ---------- loading weather ---------- */

function showCachedWeather(location) {
	const entry = loadWeatherCache(storage, location);
	if (!entry) {
		return false;
	}
	renderWeather(entry.weather, {
		fetchedAt: entry.fetchedAt,
		fromCache: true,
	});
	return true;
}

async function loadWeather(location, revision) {
	renderLoading();

	if (navigator.onLine === false && showCachedWeather(location)) {
		return;
	}

	try {
		const { data, cachedAt } = await requestJson(
			buildWeatherUrl(location),
		);
		if (revision !== state.locationRevision) {
			return;
		}
		const weather = normalizeWeatherResponse(data);
		const fetchedAt = cachedAt ?? Date.now();
		saveWeatherCache(storage, location, weather, fetchedAt);
		renderWeather(weather, {
			fetchedAt,
			fromCache: cachedAt !== null,
		});
	} catch (error) {
		if (revision !== state.locationRevision) {
			return;
		}
		if (showCachedWeather(location)) {
			return;
		}
		renderError(
			navigator.onLine === false
				? "You're offline and no saved forecast exists for this location."
				: error.message ||
						"Could not load the weather forecast.",
		);
	}
}

/* ---------- location ---------- */

function getLocationLabel(result) {
	const address = result.address ?? {};
	const place =
		address.city ||
		address.town ||
		address.village ||
		address.municipality ||
		address.county ||
		result.name ||
		"Current location";
	const countryCode = address.country_code?.toUpperCase();
	return countryCode ? `${place}, ${countryCode}` : place;
}

function renderLocation() {
	const label = state.location?.label ?? "Locating...";
	setText(elements.locationName, label);
	elements.locationName.title = label;
	renderComfortQuestion();
}

async function resolveLocationName(location, revision) {
	const parameters = new URLSearchParams({
		format: "jsonv2",
		lat: String(location.latitude),
		lon: String(location.longitude),
		zoom: "10",
		addressdetails: "1",
	});
	try {
		const { data } = await requestJson(
			`${GEOCODING_API_URL}/reverse?${parameters.toString()}`,
		);
		if (revision !== state.locationRevision) {
			return;
		}
		state.location.label = getLocationLabel(data);
		state.settings.location = { ...state.location };
		persistSettings();
		renderLocation();
	} catch {
		// The forecast remains usable when reverse geocoding is unavailable.
	}
}

function chooseLocation(location, shouldResolveName = false) {
	state.locationRevision += 1;
	const revision = state.locationRevision;
	state.location = location;
	state.settings.location = { ...location };
	persistSettings();
	renderLocation();
	closeLocationMenu();
	loadWeather(location, revision);
	if (shouldResolveName) {
		resolveLocationName(location, revision);
	}
}

function handleGeolocationError(error) {
	const messages = {
		1: "Location access was declined. Search for a city instead.",
		2: "Your location could not be determined. Search for a city instead.",
		3: "Location lookup timed out. Search for a city instead.",
	};
	const message =
		messages[error.code] ?? "Search for a city to get started.";
	if (error.code === 1) {
		state.settings.geoPreference = "denied";
		persistSettings();
	}
	if (!state.location && state.settings.location) {
		chooseLocation(state.settings.location, false);
		setAppStatus(message);
		return;
	}
	if (!state.location) {
		renderChooseLocation(message);
	}
	openLocationMenu();
	setText(elements.locationSearchStatus, message);
}

// Only called from an explicit click, or at startup once permission is already granted.
function requestDeviceLocation() {
	if (!navigator.geolocation) {
		handleGeolocationError({ code: 2 });
		return;
	}
	if (!state.weather) {
		renderLoading("Waiting for location permission...");
	}

	const startingRevision = state.locationRevision;
	navigator.geolocation.getCurrentPosition(
		({ coords }) => {
			if (startingRevision !== state.locationRevision) {
				return;
			}
			state.settings.geoPreference = "granted";
			chooseLocation(
				{
					latitude: coords.latitude,
					longitude: coords.longitude,
					label: "Current location",
				},
				true,
			);
		},
		(error) => {
			if (startingRevision !== state.locationRevision) {
				return;
			}
			handleGeolocationError(error);
		},
		{
			enableHighAccuracy: false,
			maximumAge: 10 * 60 * 1000,
			timeout: 10000,
		},
	);
}

async function isGeolocationPermitted() {
	if (
		state.settings.geoPreference !== "granted" ||
		!navigator.permissions
	) {
		return false;
	}
	try {
		const status = await navigator.permissions.query({
			name: "geolocation",
		});
		return status.state === "granted";
	} catch {
		return false;
	}
}

function openLocationMenu() {
	elements.locationPanel.inert = false;
	elements.locationPanel.dataset.open = "true";
	elements.locationButton.setAttribute("aria-expanded", "true");
	window.requestAnimationFrame(() => elements.locationInput.focus());
}

function closeLocationMenu() {
	if (elements.locationPanel.dataset.open !== "true") {
		return;
	}
	if (elements.locationPanel.contains(document.activeElement)) {
		elements.locationButton.focus();
	}
	elements.locationPanel.dataset.open = "false";
	elements.locationPanel.inert = true;
	elements.locationButton.setAttribute("aria-expanded", "false");
}

function toggleLocationMenu() {
	if (elements.locationPanel.dataset.open === "true") {
		closeLocationMenu();
	} else {
		openLocationMenu();
	}
}

function renderSearchResults(results) {
	elements.locationResults.replaceChildren();
	if (results.length === 0) {
		const emptyState = document.createElement("p");
		emptyState.className = "search-empty";
		emptyState.textContent = "No matching locations found.";
		elements.locationResults.append(emptyState);
		return;
	}
	results.forEach((result, index) => {
		const item = document.createElement("li");
		const button = document.createElement("button");
		button.className = "search-result";
		button.type = "button";
		button.dataset.resultIndex = String(index);
		const primary = document.createElement("strong");
		primary.textContent = getLocationLabel(result);
		const secondary = document.createElement("span");
		secondary.textContent = result.display_name;
		button.append(primary, secondary);
		item.append(button);
		elements.locationResults.append(item);
	});
}

function showSearchResults(results) {
	state.searchResults = results;
	renderSearchResults(results);
	setText(
		elements.locationSearchStatus,
		`${results.length} location${results.length === 1 ? "" : "s"} found.`,
	);
}

async function searchLocations(query) {
	const key = query.toLowerCase();
	if (key === lastQuery) {
		return;
	}
	lastQuery = key;
	searchController?.abort();

	if (searchCache.has(key)) {
		showSearchResults(searchCache.get(key));
		return;
	}

	const controller = new AbortController();
	searchController = controller;
	const parameters = new URLSearchParams({
		format: "jsonv2",
		q: query,
		limit: "5",
		addressdetails: "1",
	});
	setText(elements.locationSearchStatus, "Searching...");
	elements.locationSearchButton.disabled = true;

	try {
		const { data } = await requestJson(
			`${GEOCODING_API_URL}/search?${parameters.toString()}`,
			{ signal: controller.signal },
		);
		const results = Array.isArray(data) ? data : [];
		searchCache.set(key, results);
		showSearchResults(results);
	} catch (error) {
		if (controller.signal.aborted) {
			return;
		}
		lastQuery = "";
		state.searchResults = [];
		elements.locationResults.replaceChildren();
		setText(
			elements.locationSearchStatus,
			error.message || "Location search failed. Try again.",
		);
	} finally {
		if (searchController === controller) {
			elements.locationSearchButton.disabled = false;
		}
	}
}

const debouncedSearch = debounce(searchLocations, SEARCH_DEBOUNCE_MS);

function handleLocationInput() {
	const query = elements.locationInput.value.trim();
	if (query.length < MIN_QUERY_LENGTH) {
		debouncedSearch.cancel();
		return;
	}
	debouncedSearch(query);
}

function handleLocationSearch(event) {
	event.preventDefault();
	debouncedSearch.cancel();
	const query = elements.locationInput.value.trim();
	if (query.length < MIN_QUERY_LENGTH) {
		setText(
			elements.locationSearchStatus,
			"Enter at least 2 characters.",
		);
		elements.locationInput.focus();
		return;
	}
	searchLocations(query);
}

function handleSearchResultClick(event) {
	const button = event.target.closest("[data-result-index]");
	const result =
		button &&
		state.searchResults[Number(button.dataset.resultIndex)];
	if (!result) {
		return;
	}
	chooseLocation({
		latitude: toFiniteNumber(result.lat),
		longitude: toFiniteNumber(result.lon),
		label: getLocationLabel(result),
	});
}

/* ---------- settings UI ---------- */

const COMFORT_DESCRIPTIONS = {
	1: "Unbearable",
	2: "Too warm",
	3: "Fine",
	4: "Comfortable",
	5: "Wouldn't leave without it",
};

function renderComfortQuestion() {
	const warmest = state.settings.labels.hoodie.toLowerCase();
	const average = state.weather?.weekAverage;
	const where = state.location?.label ?? "your area";
	setText(
		elements.comfortQuestion,
		Number.isFinite(average)
			? `How comfortable are you in your ${warmest} at ${Math.round(average)}\u00B0C, the average in ${where} over the last week?`
			: `How comfortable are you in your ${warmest} on an average day this week?`,
	);
	setText(
		elements.comfortDescription,
		`${state.settings.comfort}: ${COMFORT_DESCRIPTIONS[state.settings.comfort]}`,
	);
}

function syncSettingsControls() {
	const { settings } = state;
	elements.exposureInputs.forEach((input) => {
		input.checked = (input.value === "long") === isLongTrip();
	});
	elements.forecastHours.value = String(state.forecastHours);
	elements.comfortInputs.forEach((input) => {
		input.checked = Number(input.value) === settings.comfort;
	});
	renderComfortQuestion();
	elements.labelInputs.forEach((input) => {
		const key = input.dataset.tierLabel;
		input.value =
			settings.labels[key] === DEFAULT_LABELS[key]
				? ""
				: settings.labels[key];
		input.placeholder = DEFAULT_LABELS[key];
	});
	elements.availableInputs.forEach((input) => {
		input.checked = settings.available[input.dataset.available];
	});
	updateStepperSummary();
}

let recomputeScheduled = false;
function scheduleRecommendation() {
	if (recomputeScheduled) {
		return;
	}
	recomputeScheduled = true;
	window.requestAnimationFrame(() => {
		recomputeScheduled = false;
		renderRecommendation();
	});
}

const saveSettingsSoon = debounce(persistSettings, 250);

// Trip length lives in forecastHours; the radios and exposure setting just mirror it.
function setForecastHours(hours) {
	state.forecastHours = hours;
	state.settings.exposure = isLongTrip() ? "long" : "short";
	persistSettings();
	syncSettingsControls();
	scheduleRecommendation();
}

function handleExposureChange(event) {
	setForecastHours(
		event.target.value === "long"
			? LONG_TRIP_DEFAULT_HOURS
			: SHORT_TRIP_DEFAULT_HOURS,
	);
}

function handleComfortChange(event) {
	state.settings.comfort = sanitizeComfort(event.target.value);
	renderComfortQuestion();
	persistSettings();
	scheduleRecommendation();
}

function handleLabelInput() {
	const labels = { ...DEFAULT_LABELS };
	elements.labelInputs.forEach((input) => {
		labels[input.dataset.tierLabel] = input.value;
	});
	state.settings.labels = sanitizeSettings({ labels }).labels;
	renderComfortQuestion();
	saveSettingsSoon();
	scheduleRecommendation();
}

function handleResetSettings() {
	const defaults = sanitizeSettings(null);
	Object.assign(state.settings, {
		comfort: defaults.comfort,
		labels: defaults.labels,
		available: defaults.available,
	});
	setForecastHours(SHORT_TRIP_DEFAULT_HOURS);
}

function handleAvailableChange() {
	const available = {};
	elements.availableInputs.forEach((input) => {
		available[input.dataset.available] = input.checked;
	});
	state.settings.available = sanitizeSettings({ available }).available;
	elements.availableInputs.forEach((input) => {
		input.checked =
			state.settings.available[input.dataset.available];
	});
	persistSettings();
	scheduleRecommendation();
}

/* ---------- personalisation stepper ---------- */

const STEP_COUNT = 3;
let currentStep = 0;

function updateStepperSummary() {
	const { settings } = state;
	const parts = [];
	parts.push(`Trip: ${isLongTrip() ? "Long" : "Short"}`);
	parts.push(
		`Clothes: ${Object.values(settings.available).filter(Boolean).length}`,
	);
	parts.push(`Comfort: ${COMFORT_DESCRIPTIONS[settings.comfort]}`);
	setText(elements.stepperSummaryText, parts.join(" \u00B7 "));
}

function showStep(index, { focus = false } = {}) {
	currentStep = Math.min(Math.max(index, 0), STEP_COUNT - 1);
	elements.steps.forEach((step, stepIndex) => {
		step.hidden = stepIndex !== currentStep;
	});
	elements.stepButtons.forEach((button, buttonIndex) => {
		if (buttonIndex === currentStep) {
			button.setAttribute("aria-current", "step");
		} else {
			button.removeAttribute("aria-current");
		}
	});
	elements.stepBack.hidden = currentStep === 0;
	setText(
		elements.stepNext,
		currentStep === STEP_COUNT - 1 ? "Done" : "Next",
	);
	if (focus) {
		elements.steps[currentStep].querySelector("input")?.focus();
	}
}

function setStepperOpen(open) {
	if (!open && elements.stepperBody.contains(document.activeElement)) {
		elements.stepperEdit.focus();
	}
	elements.stepper.dataset.open = String(open);
	elements.stepperBody.inert = !open;
	elements.stepperEdit.setAttribute("aria-expanded", String(open));
	setText(elements.stepperEdit, open ? "Close" : "Expand");
	if (open) {
		showStep(0, { focus: true });
	}
}

function handleStepSubmit(event) {
	event.preventDefault();
	if (currentStep < STEP_COUNT - 1) {
		showStep(currentStep + 1, { focus: true });
	} else {
		setStepperOpen(false);
	}
}

function handleStepperKeydown(event) {
	if (
		event.key === "Escape" &&
		elements.stepper.dataset.open === "true"
	) {
		event.stopPropagation();
		setStepperOpen(false);
	}
}

/* ---------- trends ---------- */

const TREND_LOOKAHEAD_HOURS = 3;
const TREND_THRESHOLDS = {
	temperature: 0.5,
	feelsLike: 0.5,
	windSpeed: 2,
	precipitation: 0.1,
};
const TREND_LABELS = { up: "rising", down: "falling" };

// Compares the live reading with the mean of the next few forecast hours.
function renderTrend(node, key, currentValue) {
	const upcoming = state.weather.hourly
		.slice(1, 1 + TREND_LOOKAHEAD_HOURS)
		.map((hour) => hour[key])
		.filter(Number.isFinite);
	let trend = "";
	if (upcoming.length > 0 && Number.isFinite(currentValue)) {
		const mean =
			upcoming.reduce((total, value) => total + value, 0) /
			upcoming.length;
		const difference = mean - currentValue;
		if (Math.abs(difference) >= TREND_THRESHOLDS[key]) {
			trend = difference > 0 ? "up" : "down";
		}
	}
	if (trend) {
		node.dataset.trend = trend;
		node.setAttribute("role", "img");
		node.setAttribute(
			"aria-label",
			`${TREND_LABELS[trend]} over the next ${TREND_LOOKAHEAD_HOURS} hours`,
		);
		node.title = node.getAttribute("aria-label");
	} else {
		delete node.dataset.trend;
		node.removeAttribute("role");
		node.removeAttribute("aria-label");
		node.removeAttribute("title");
	}
}

function handleForecastHoursChange(event) {
	const forecastHours = Number(event.currentTarget.value);
	if (
		!Number.isInteger(forecastHours) ||
		forecastHours < 1 ||
		forecastHours > FORECAST_HOURS
	) {
		event.currentTarget.value = String(state.forecastHours);
		return;
	}
	setForecastHours(forecastHours);
}

/* ---------- boot ---------- */

function cacheDomElements() {
	const $ = (selector) => document.querySelector(selector);
	Object.assign(elements, {
		alertList: $("#alert-list"),
		alerts: $("#alerts"),
		bestNextEyebrow: $("#best-next-eyebrow"),
		availableInputs: document.querySelectorAll("[data-available]"),
		stepper: $("#personalise"),
		stepperBody: $("#stepper-body"),
		stepperEdit: $("#stepper-edit"),
		stepperSummaryText: $("#stepper-summary-text"),
		steps: document.querySelectorAll(".step"),
		stepButtons: document.querySelectorAll("[data-step-target]"),
		stepBack: $("#step-back"),
		stepNext: $("#step-next"),
		trendTemperature: $("#trend-temperature"),
		trendFeelsLike: $("#trend-feels-like"),
		trendWind: $("#trend-wind"),
		trendRain: $("#trend-rain"),
		locationPanel: $("#location-panel"),
		locationMenu: $("#location-menu"),
		currentCondition: $("#current-condition"),
		currentFeelsLike: $("#current-feels-like"),
		currentRain: $("#current-rain"),
		currentTemperature: $("#current-temperature"),
		currentWind: $("#current-wind"),
		exposureInputs: document.querySelectorAll(
			'input[name="exposure"]',
		),
		footwear: $("#footwear"),
		footwearDetail: $("#footwear-detail"),
		footwearTitle: $("#footwear-title"),
		forecastHours: $("#forecast-hours"),
		forecastList: $("#forecast-list"),
		heroEyebrow: $("#hero-eyebrow"),
		heroReason: $("#hero-reason"),
		heroScore: $("#hero-score"),
		heroScoreLabel: $("#hero-score-label"),
		heroTitle: $("#hero-title"),
		labelInputs: document.querySelectorAll("[data-tier-label]"),
		locationButton: $("#location-button"),
		locationForm: $("#location-form"),
		locationInput: $("#location-input"),
		locationName: $("#location-name"),
		locationResults: $("#location-results"),
		locationSearchButton: $("#location-search-button"),
		locationSearchStatus: $("#location-search-status"),
		offlineBadge: $("#offline-badge"),
		resetSettings: $("#reset-settings"),
		retryButton: $("#retry-button"),
		status: $("#app-status"),
		comfortInputs: document.querySelectorAll(
			'input[name="comfort"]',
		),
		comfortQuestion: $("#comfort-question"),
		comfortDescription: $("#comfort-description"),
		tierList: $("#tier-list"),
		useDeviceLocationButton: $("#use-device-location"),
	});
}

function bindEvents() {
	elements.forecastHours.addEventListener(
		"change",
		handleForecastHoursChange,
	);
	elements.locationButton.addEventListener("click", toggleLocationMenu);
	elements.locationForm.addEventListener("submit", handleLocationSearch);
	elements.locationInput.addEventListener("input", handleLocationInput);
	elements.locationResults.addEventListener(
		"click",
		handleSearchResultClick,
	);
	elements.exposureInputs.forEach((input) =>
		input.addEventListener("change", handleExposureChange),
	);
	elements.comfortInputs.forEach((input) =>
		input.addEventListener("change", handleComfortChange),
	);
	elements.labelInputs.forEach((input) =>
		input.addEventListener("input", handleLabelInput),
	);
	elements.resetSettings.addEventListener("click", handleResetSettings);
	elements.availableInputs.forEach((input) =>
		input.addEventListener("change", handleAvailableChange),
	);
	elements.stepper.addEventListener("submit", handleStepSubmit);
	elements.stepper.addEventListener("keydown", handleStepperKeydown);
	elements.stepperEdit.addEventListener("click", () =>
		setStepperOpen(elements.stepper.dataset.open !== "true"),
	);
	elements.stepBack.addEventListener("click", () =>
		showStep(currentStep - 1, { focus: true }),
	);
	elements.stepButtons.forEach((button) =>
		button.addEventListener("click", () =>
			showStep(Number(button.dataset.stepTarget), {
				focus: true,
			}),
		),
	);
	elements.retryButton.addEventListener("click", (event) => {
		event.stopPropagation();
		if (state.location) {
			loadWeather(state.location, state.locationRevision);
		} else {
			openLocationMenu();
		}
	});
	elements.useDeviceLocationButton.addEventListener("click", () => {
		setText(
			elements.locationSearchStatus,
			"Finding your location...",
		);
		requestDeviceLocation();
	});
	document.addEventListener("click", (event) => {
		if (!elements.locationMenu.contains(event.target)) {
			closeLocationMenu();
		}
	});
	elements.locationMenu.addEventListener("focusout", (event) => {
		const next = event.relatedTarget;
		if (next && !elements.locationMenu.contains(next)) {
			closeLocationMenu();
		}
	});
	elements.locationMenu.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			closeLocationMenu();
		}
	});
	window.addEventListener("online", () => {
		if (state.location) {
			loadWeather(state.location, state.locationRevision);
		}
	});
	window.addEventListener("offline", () => {
		if (state.weather) {
			state.fromCache = true;
			renderBadge();
		}
	});
	// Last-resort boundary: keep the DOM usable and recoverable.
	const fail = () => {
		if (document.body.dataset.view === "loading") {
			renderError("Something went wrong. Please try again.");
		}
	};
	window.addEventListener("error", fail);
	window.addEventListener("unhandledrejection", fail);
}

function registerServiceWorker() {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.register("./sw.js").catch(() => {
			// Service worker failure does not prevent the live forecast from loading.
		});
	}
}

async function startApp() {
	if (await isGeolocationPermitted()) {
		requestDeviceLocation();
		return;
	}
	const saved = state.settings.location;
	if (saved) {
		chooseLocation(saved, false);
		return;
	}
	renderChooseLocation(
		"Search for a city, or use your current location.",
	);
	openLocationMenu();
}

function initializeApp() {
	cacheDomElements();
	state.forecastHours =
		state.settings.exposure === "long"
			? LONG_TRIP_DEFAULT_HOURS
			: SHORT_TRIP_DEFAULT_HOURS;
	syncSettingsControls();
	showStep(0);
	bindEvents();
	registerServiceWorker();
	renderLoading("Getting started...");
	startApp();
}

document.addEventListener("DOMContentLoaded", initializeApp);
