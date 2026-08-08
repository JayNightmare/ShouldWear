"use strict";

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_API_URL = "https://nominatim.openstreetmap.org";
const FORECAST_HOURS = 8;
const API_TIMEOUT_MS = 12000;

const CLOTHING_TIERS = [
	{
		id: "hoodie",
		label: "Hoodie",
		shortLabel: "HD",
		rainPenalty: 0,
		windBonus: 15,
		curve: [
			[-5, 0],
			[4, 35],
			[8, 100],
			[14, 100],
			[18, 30],
			[24, 0],
		],
	},
	{
		id: "jumper",
		label: "Light Jumper",
		shortLabel: "LJ",
		rainPenalty: 10,
		windBonus: 8,
		curve: [
			[5, 0],
			[10, 40],
			[14, 100],
			[18, 100],
			[20, 100],
			[24, 35],
			[29, 0],
		],
	},
	{
		id: "shirt",
		label: "T-Shirt / Shirt only",
		shortLabel: "TS",
		rainPenalty: 24,
		windBonus: 0,
		curve: [
			[8, 0],
			[14, 5],
			[18, 50],
			[20, 100],
			[40, 100],
		],
	},
];

const state = {
	forecastHours: FORECAST_HOURS,
	location: null,
	locationRevision: 0,
	searchResults: [],
	theme: "dark",
	topTier: null,
	weather: null,
};

const elements = {};

function clamp(value, minimum = 0, maximum = 100) {
	return Math.min(maximum, Math.max(minimum, value));
}

function interpolateScore(temperature, curve) {
	if (temperature <= curve[0][0]) {
		return curve[0][1];
	}

	for (let index = 1; index < curve.length; index += 1) {
		const [upperTemperature, upperScore] = curve[index];
		const [lowerTemperature, lowerScore] = curve[index - 1];

		if (temperature <= upperTemperature) {
			const progress =
				(temperature - lowerTemperature) /
				(upperTemperature - lowerTemperature);
			return (
				lowerScore +
				progress * (upperScore - lowerScore)
			);
		}
	}

	return curve[curve.length - 1][1];
}

function getHourWeight(index) {
	if (index < 3) {
		return 1;
	}

	if (index < 6) {
		return 0.7;
	}

	return 0.4;
}

function calculateTierScores(hourlyData, forecastHours = FORECAST_HOURS) {
	const hours = hourlyData.slice(0, forecastHours);

	if (hours.length === 0) {
		throw new Error("Hourly forecast data is unavailable.");
	}

	const rainRisk = hours
		.slice(0, 6)
		.some((hour) => hour.precipitationProbability > 50);

	const scores = CLOTHING_TIERS.map((tier) => {
		let weightedScore = 0;
		let totalWeight = 0;

		hours.forEach((hour, index) => {
			const weight = getHourWeight(index);
			let hourlyScore = interpolateScore(
				hour.feelsLike,
				tier.curve,
			);

			if (hour.windSpeed > 20) {
				hourlyScore += tier.windBonus;
			}

			if (rainRisk) {
				hourlyScore -= tier.rainPenalty;
			}

			weightedScore += clamp(hourlyScore) * weight;
			totalWeight += weight;
		});

		return {
			...tier,
			score: Math.round(clamp(weightedScore / totalWeight)),
		};
	});

	return { rainRisk, scores };
}

function selectTopTier(scores) {
	return scores.reduce((best, tier) =>
		tier.score > best.score ? tier : best,
	);
}

function toFiniteNumber(value, fallback = 0) {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
}

function normalizeWeatherResponse(data) {
	if (!data.current || !data.hourly || !Array.isArray(data.hourly.time)) {
		throw new Error(
			"The weather service returned an incomplete forecast.",
		);
	}

	const startIndex = Math.max(
		0,
		data.hourly.time.findIndex((time) => time >= data.current.time),
	);

	const hourly = data.hourly.time
		.slice(startIndex, startIndex + FORECAST_HOURS)
		.map((time, offset) => {
			const index = startIndex + offset;
			return {
				time,
				temperature: toFiniteNumber(
					data.hourly.temperature_2m?.[index],
				),
				feelsLike: toFiniteNumber(
					data.hourly.apparent_temperature?.[
						index
					],
					toFiniteNumber(
						data.hourly.temperature_2m?.[
							index
						],
					),
				),
				precipitationProbability: toFiniteNumber(
					data.hourly.precipitation_probability?.[
						index
					],
				),
				precipitation: toFiniteNumber(
					data.hourly.precipitation?.[index],
				),
				windSpeed: toFiniteNumber(
					data.hourly.wind_speed_10m?.[index] ??
						data.hourly.windspeed_10m?.[
							index
						],
				),
				weatherCode: toFiniteNumber(
					data.hourly.weather_code?.[index] ??
						data.hourly.weathercode?.[
							index
						],
				),
			};
		});

	if (hourly.length < FORECAST_HOURS) {
		throw new Error(
			"A complete 8 hour forecast is not available yet.",
		);
	}

	return {
		current: {
			time: data.current.time,
			temperature: toFiniteNumber(
				data.current.temperature_2m,
			),
			feelsLike: toFiniteNumber(
				data.current.apparent_temperature,
				toFiniteNumber(data.current.temperature_2m),
			),
			precipitation: toFiniteNumber(
				data.current.precipitation,
			),
			windSpeed: toFiniteNumber(
				data.current.wind_speed_10m ??
					data.current.windspeed_10m,
			),
			weatherCode: toFiniteNumber(
				data.current.weather_code ??
					data.current.weathercode,
			),
		},
		hourly,
		timezone: data.timezone,
	};
}

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
		timezone: "auto",
	});

	return `${WEATHER_API_URL}?${parameters.toString()}`;
}

async function requestJson(url) {
	const controller = new AbortController();
	const timeout = window.setTimeout(
		() => controller.abort(),
		API_TIMEOUT_MS,
	);

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

		return await response.json();
	} catch (error) {
		if (error.name === "AbortError") {
			throw new Error(
				"The request took too long. Please try again.",
			);
		}
		throw error;
	} finally {
		window.clearTimeout(timeout);
	}
}

function setAppStatus(message) {
	elements.status.textContent = message;
}

function renderLoading(message = "Reading the next 8 hours...") {
	state.topTier = null;
	state.weather = null;
	document.body.dataset.view = "loading";
	elements.heroEyebrow.textContent = "Forecast in progress";
	elements.heroTitle.textContent = "Looking outside";
	elements.heroScore.textContent = "--";
	elements.heroScoreLabel.textContent = "acceptance";
	elements.heroReason.textContent = message;
	elements.currentCondition.textContent = "--";
	elements.currentTemperature.textContent = "--\u00B0";
	elements.currentFeelsLike.textContent = "--\u00B0";
	elements.currentWind.textContent = "-- km/h";
	elements.currentRain.textContent = "-- mm";
	elements.tierList.replaceChildren();
	elements.forecastList.replaceChildren();
	setAppStatus(message);
}

function renderError(message) {
	document.body.dataset.view = "error";
	elements.heroEyebrow.textContent = "Forecast unavailable";
	elements.heroTitle.textContent = "No answer yet";
	elements.heroScore.textContent = "--";
	elements.heroScoreLabel.textContent = "acceptance";
	elements.heroReason.textContent = message;
	elements.retryButton.hidden = false;
	setAppStatus(message);
}

function formatForecastWindow(forecastHours) {
	return forecastHours === 1
		? "the next hour"
		: `the next ${forecastHours} hours`;
}

function getRecommendationReason(weather, rainRisk, forecastHours) {
	const hours = weather.hourly.slice(0, forecastHours);
	const forecastWindow = formatForecastWindow(forecastHours);
	const strongestWind = Math.max(...hours.map((hour) => hour.windSpeed));
	const temperatureChange =
		hours[hours.length - 1].feelsLike - hours[0].feelsLike;

	if (rainRisk) {
		return `Rain is likely within ${formatForecastWindow(Math.min(forecastHours, 6))}.`;
	}
	if (strongestWind > 20) {
		return `Wind reaches ${Math.round(strongestWind)} km/h within ${forecastWindow}.`;
	}
	if (temperatureChange <= -4) {
		return `It will feel noticeably cooler within ${forecastWindow}.`;
	}
	if (temperatureChange >= 4) {
		return `It will feel noticeably warmer within ${forecastWindow}.`;
	}
	if (hours.every((hour) => hour.precipitationProbability < 20)) {
		return `Conditions stay settled for ${forecastWindow}.`;
	}
	return `Conditions remain fairly steady for ${forecastWindow}.`;
}

function announceRecommendation(topTier) {
	const locationLabel = state.location?.label ?? "your location";
	setAppStatus(
		`For ${locationLabel}, ${topTier.label} is the top recommendation for ${formatForecastWindow(state.forecastHours)}, with ${topTier.score} percent acceptance.`,
	);
}

function createTierElement(tier, isTopTier) {
	const item = document.createElement("article");
	item.className = "tier-item";
	if (isTopTier) {
		item.classList.add("tier-item--recommended");
	}

	const headingRow = document.createElement("div");
	headingRow.className = "tier-heading";

	const name = document.createElement("h3");
	name.textContent = tier.label;

	const value = document.createElement("span");
	value.className = "tier-value";
	value.textContent = `${tier.score}%`;

	const bar = document.createElement("div");
	bar.className = "acceptance-bar";
	bar.setAttribute("role", "progressbar");
	bar.setAttribute("aria-label", `${tier.label} acceptance`);
	bar.setAttribute("aria-valuemin", "0");
	bar.setAttribute("aria-valuemax", "100");
	bar.setAttribute("aria-valuenow", String(tier.score));
	bar.style.setProperty("--score", `${tier.score}%`);

	const fill = document.createElement("span");
	fill.className = "acceptance-fill";
	bar.append(fill);

	headingRow.append(name, value);
	item.append(headingRow, bar);
	return item;
}

function formatHour(isoTime) {
	const hour = Number(isoTime.slice(11, 13));
	const normalizedHour = hour % 12 || 12;
	return `${normalizedHour}${hour < 12 ? "am" : "pm"}`;
}

function createForecastElement(hour, index) {
	const descriptor = getWeatherDescriptor(hour.weatherCode);
	const item = document.createElement("li");
	item.className = "forecast-hour";

	const time = document.createElement("time");
	time.dateTime = hour.time;
	time.textContent = index === 0 ? "Now" : formatHour(hour.time);

	const icon = document.createElement("span");
	icon.className = "forecast-icon";
	icon.setAttribute("role", "img");
	icon.setAttribute("aria-label", descriptor.label);
	icon.textContent = descriptor.icon;

	const temperature = document.createElement("strong");
	temperature.textContent = `${Math.round(hour.temperature)}\u00B0`;

	const rain = document.createElement("span");
	rain.className = "forecast-rain";
	rain.textContent = `${Math.round(hour.precipitationProbability)}%`;
	rain.setAttribute(
		"aria-label",
		`${Math.round(hour.precipitationProbability)} percent chance of rain`,
	);

	item.append(time, icon, temperature, rain);
	return item;
}

function renderWeather(weather) {
	const { rainRisk, scores } = calculateTierScores(
		weather.hourly,
		state.forecastHours,
	);
	const topTier = selectTopTier(scores);
	const currentDescriptor = getWeatherDescriptor(
		weather.current.weatherCode,
	);

	state.weather = weather;
	state.topTier = topTier;
	document.body.dataset.view = "ready";
	document.body.dataset.recommendation = topTier.id;
	elements.retryButton.hidden = true;
	elements.heroEyebrow.textContent = "Top recommendation";
	elements.heroTitle.textContent = topTier.label;
	elements.heroScore.textContent = String(topTier.score);
	elements.heroScoreLabel.textContent = "% acceptance";
	elements.heroMonogram.textContent = topTier.shortLabel;
	elements.heroReason.textContent = getRecommendationReason(
		weather,
		rainRisk,
		state.forecastHours,
	);
	elements.currentCondition.textContent = currentDescriptor.label;
	elements.currentTemperature.textContent = `${Math.round(weather.current.temperature)}\u00B0`;
	elements.currentFeelsLike.textContent = `${Math.round(weather.current.feelsLike)}\u00B0`;
	elements.currentWind.textContent = `${Math.round(weather.current.windSpeed)} km/h`;
	elements.currentRain.textContent = `${weather.current.precipitation.toFixed(1)} mm`;

	elements.tierList.replaceChildren(
		...scores.map((tier) =>
			createTierElement(tier, tier.id === topTier.id),
		),
	);
	elements.forecastList.replaceChildren(
		...weather.hourly.map(createForecastElement),
	);

	announceRecommendation(topTier);
}

async function loadWeather(location, revision) {
	renderLoading();

	try {
		const data = await requestJson(buildWeatherUrl(location));
		if (revision !== state.locationRevision) {
			return;
		}
		renderWeather(normalizeWeatherResponse(data));
	} catch (error) {
		if (revision !== state.locationRevision) {
			return;
		}
		renderError(
			error.message || "Could not load the weather forecast.",
		);
	}
}

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
	elements.locationName.textContent =
		state.location?.label ?? "Locating...";
	elements.locationName.title =
		state.location?.label ?? "Finding your location";
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
		const result = await requestJson(
			`${GEOCODING_API_URL}/reverse?${parameters.toString()}`,
		);
		if (revision !== state.locationRevision) {
			return;
		}
		state.location.label = getLocationLabel(result);
		renderLocation();
		if (state.topTier) {
			announceRecommendation(state.topTier);
		}
	} catch {
		// The forecast remains usable when reverse geocoding is unavailable.
	}
}

function chooseLocation(location, shouldResolveName = false) {
	state.locationRevision += 1;
	const revision = state.locationRevision;
	state.location = location;
	renderLocation();
	closeLocationDialog();
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
	renderError(message);
	openLocationDialog();
}

function requestDeviceLocation() {
	renderLoading("Waiting for location permission...");

	if (!navigator.geolocation) {
		handleGeolocationError({ code: 2 });
		return;
	}

	const startingRevision = state.locationRevision;
	navigator.geolocation.getCurrentPosition(
		({ coords }) => {
			if (startingRevision !== state.locationRevision) {
				return;
			}
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

function openLocationDialog() {
	if (!elements.locationDialog.open) {
		elements.locationDialog.showModal();
	}
	window.requestAnimationFrame(() => elements.locationInput.focus());
}

function closeLocationDialog() {
	if (elements.locationDialog.open) {
		elements.locationDialog.close();
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

async function searchLocations(query) {
	const parameters = new URLSearchParams({
		format: "jsonv2",
		q: query,
		limit: "5",
		addressdetails: "1",
	});

	elements.locationSearchStatus.textContent = "Searching...";
	elements.locationSearchButton.disabled = true;

	try {
		const results = await requestJson(
			`${GEOCODING_API_URL}/search?${parameters.toString()}`,
		);
		state.searchResults = Array.isArray(results) ? results : [];
		renderSearchResults(state.searchResults);
		elements.locationSearchStatus.textContent = `${state.searchResults.length} location${state.searchResults.length === 1 ? "" : "s"} found.`;
	} catch (error) {
		state.searchResults = [];
		elements.locationResults.replaceChildren();
		elements.locationSearchStatus.textContent =
			error.message || "Location search failed.";
	} finally {
		elements.locationSearchButton.disabled = false;
	}
}

function handleLocationSearch(event) {
	event.preventDefault();
	const query = elements.locationInput.value.trim();

	if (query.length < 2) {
		elements.locationSearchStatus.textContent =
			"Enter at least 2 characters.";
		elements.locationInput.focus();
		return;
	}

	searchLocations(query);
}

function handleSearchResultClick(event) {
	const button = event.target.closest("[data-result-index]");
	if (!button) {
		return;
	}

	const result = state.searchResults[Number(button.dataset.resultIndex)];
	if (!result) {
		return;
	}

	chooseLocation({
		latitude: toFiniteNumber(result.lat),
		longitude: toFiniteNumber(result.lon),
		label: getLocationLabel(result),
	});
}

function toggleTheme() {
	state.theme = state.theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = state.theme;
	elements.themeToggle.setAttribute(
		"aria-label",
		`Switch to ${state.theme === "dark" ? "light" : "dark"} theme`,
	);
	elements.themeToggle.setAttribute(
		"aria-pressed",
		String(state.theme === "light"),
	);

	const themeColor = document.querySelector('meta[name="theme-color"]');
	themeColor.content = state.theme === "dark" ? "#171614" : "#f3f1ec";
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

	state.forecastHours = forecastHours;
	if (state.weather) {
		renderWeather(state.weather);
	}
}

function cacheDomElements() {
	Object.assign(elements, {
		closeLocationButton: document.querySelector("#close-location"),
		currentCondition: document.querySelector("#current-condition"),
		currentFeelsLike: document.querySelector("#current-feels-like"),
		currentRain: document.querySelector("#current-rain"),
		currentTemperature: document.querySelector(
			"#current-temperature",
		),
		currentWind: document.querySelector("#current-wind"),
		forecastHours: document.querySelector("#forecast-hours"),
		forecastList: document.querySelector("#forecast-list"),
		heroEyebrow: document.querySelector("#hero-eyebrow"),
		heroMonogram: document.querySelector("#hero-monogram"),
		heroReason: document.querySelector("#hero-reason"),
		heroScore: document.querySelector("#hero-score"),
		heroScoreLabel: document.querySelector("#hero-score-label"),
		heroTitle: document.querySelector("#hero-title"),
		locationButton: document.querySelector("#location-button"),
		locationDialog: document.querySelector("#location-dialog"),
		locationForm: document.querySelector("#location-form"),
		locationInput: document.querySelector("#location-input"),
		locationName: document.querySelector("#location-name"),
		locationResults: document.querySelector("#location-results"),
		locationSearchButton: document.querySelector(
			"#location-search-button",
		),
		locationSearchStatus: document.querySelector(
			"#location-search-status",
		),
		retryButton: document.querySelector("#retry-button"),
		status: document.querySelector("#app-status"),
		themeToggle: document.querySelector("#theme-toggle"),
		tierList: document.querySelector("#tier-list"),
		useDeviceLocationButton: document.querySelector(
			"#use-device-location",
		),
	});
}

function bindEvents() {
	elements.forecastHours.addEventListener(
		"change",
		handleForecastHoursChange,
	);
	elements.locationButton.addEventListener("click", openLocationDialog);
	elements.closeLocationButton.addEventListener(
		"click",
		closeLocationDialog,
	);
	elements.locationForm.addEventListener("submit", handleLocationSearch);
	elements.locationResults.addEventListener(
		"click",
		handleSearchResultClick,
	);
	elements.themeToggle.addEventListener("click", toggleTheme);
	elements.retryButton.addEventListener("click", () => {
		if (state.location) {
			loadWeather(state.location, state.locationRevision);
		} else {
			requestDeviceLocation();
		}
	});
	elements.useDeviceLocationButton.addEventListener("click", () => {
		closeLocationDialog();
		requestDeviceLocation();
	});
	elements.locationDialog.addEventListener("click", (event) => {
		if (event.target === elements.locationDialog) {
			closeLocationDialog();
		}
	});
}

function registerServiceWorker() {
	if ("serviceWorker" in navigator) {
		navigator.serviceWorker.register("./sw.js").catch(() => {
			// Service worker failure does not prevent the live forecast from loading.
		});
	}
}

function initializeApp() {
	cacheDomElements();
	bindEvents();
	registerServiceWorker();
	requestDeviceLocation();
}

if (typeof document !== "undefined") {
	document.addEventListener("DOMContentLoaded", initializeApp);
}

if (typeof module !== "undefined" && module.exports) {
	module.exports = {
		calculateTierScores,
		getHourWeight,
		interpolateScore,
		selectTopTier,
	};
}
