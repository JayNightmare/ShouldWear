"use strict";

/*
 * Pure, DOM-free logic: scoring, precipitation analysis, settings storage.
 * Loaded as a global (ShouldWearCore) in the browser and via require() in tests.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		root.ShouldWearCore = api;
	}
})(typeof self !== "undefined" ? self : this, function () {
	const FORECAST_HOURS = 12;
	const HOURS_KEPT = 24;
	const SETTINGS_KEY = "shouldwear:settings";
	const WEATHER_CACHE_KEY = "shouldwear:last-weather";
	const THERMAL_OFFSET_LIMIT = 5;
	const LABEL_MAX_LENGTH = 24;
	// Each step below the warmest tier's ideal range adds one "+" (a layer worn underneath).
	const LAYER_STEP_DEGREES = 3;
	const MAX_EXTRA_LAYERS = 3;
	const WEEK_HOURS = 168;
	const COMFORT_MIN = 1;
	const COMFORT_MAX = 5;
	const COMFORT_DEFAULT = 3;
	const COMFORT_DEGREES_PER_STEP = 2.5;

	const DEFAULT_LABELS = {
		hoodie: "Hoodie",
		jumper: "Light Jumper",
		shirt: "T-Shirt",
	};

	const CLOTHING_TIERS = [
		{
			id: "hoodie",
			label: DEFAULT_LABELS.hoodie,
			shortLabel: "HD",
			rainPenalty: 0,
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
			label: DEFAULT_LABELS.jumper,
			shortLabel: "LJ",
			rainPenalty: 10,
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
			label: DEFAULT_LABELS.shirt,
			shortLabel: "TS",
			rainPenalty: 24,
			curve: [
				[8, 0],
				[14, 5],
				[18, 50],
				[20, 100],
				[40, 100],
			],
		},
	];

	/*
	 * Apparent temperature from Open-Meteo already contains wind chill, so wind
	 * is never scored separately. Exposure only rescales how much of that chill
	 * is felt (chillWeight) and adds a small stationary penalty (restingOffset).
	 */
	const EXPOSURE_PROFILES = {
		short: { chillWeight: 1, restingOffset: 0 },
		long: { chillWeight: 1.6, restingOffset: -1.5 },
	};

	const PRECIP = {
		wetMm: 0.2,
		wetProbability: 40,
		moderateMm: 1,
		heavyMm: 4,
		sustainedHours: 2,
	};

	const DEFAULT_SETTINGS = {
		exposure: "short",
		thermalOffset: 0,
		comfort: 3,
		labels: { ...DEFAULT_LABELS },
		available: { hoodie: true, jumper: true, shirt: true },
		outWindow: { start: "", end: "" },
		geoPreference: null,
		theme: "dark",
		location: null,
	};

	function clamp(value, minimum = 0, maximum = 100) {
		return Math.min(maximum, Math.max(minimum, value));
	}

	function toFiniteNumber(value, fallback = 0) {
		if (value === null || value === undefined || value === "") {
			return fallback;
		}
		const number = Number(value);
		return Number.isFinite(number) ? number : fallback;
	}

	function interpolateScore(temperature, curve) {
		if (temperature <= curve[0][0]) {
			return curve[0][1];
		}
		for (let index = 1; index < curve.length; index += 1) {
			const [upperT, upperScore] = curve[index];
			const [lowerT, lowerScore] = curve[index - 1];
			if (temperature <= upperT) {
				const progress =
					(temperature - lowerT) /
					(upperT - lowerT);
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
		return index < 6 ? 0.7 : 0.4;
	}

	function getExposureProfile(exposure) {
		return EXPOSURE_PROFILES[exposure] || EXPOSURE_PROFILES.short;
	}

	// Temperature used for scoring only; displayed readings stay raw.
	function getEffectiveTemperature(hour, options = {}) {
		const profile = getExposureProfile(options.exposure);
		const offset = toFiniteNumber(options.thermalOffset);
		const chill = hour.feelsLike - hour.temperature;
		const adjustedChill =
			chill < 0 ? chill * profile.chillWeight : chill;
		return (
			hour.temperature +
			adjustedChill +
			profile.restingOffset +
			offset
		);
	}

	function parseClock(value) {
		const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
		if (!match) {
			return null;
		}
		const minutes = Number(match[1]) * 60 + Number(match[2]);
		return minutes < 1440 ? minutes : null;
	}

	function hourStartMinutes(isoTime) {
		return (
			Number(isoTime.slice(11, 13)) * 60 +
			Number(isoTime.slice(14, 16))
		);
	}

	// Hours whose slot overlaps the [start, end) out-of-house window; supports overnight windows.
	function filterHoursInWindow(hourly, window) {
		const start = parseClock(window?.start);
		let end = parseClock(window?.end);
		if (start === null || end === null || start === end) {
			return hourly;
		}
		if (end < start) {
			end += 1440;
		}
		return hourly.filter((hour) => {
			const slot = hourStartMinutes(hour.time);
			return [slot, slot + 1440].some(
				(from) => from < end && from + 60 > start,
			);
		});
	}

	function selectHours(hourly, forecastHours = FORECAST_HOURS, window) {
		const inWindow = filterHoursInWindow(hourly, window);
		if (inWindow !== hourly && inWindow.length > 0) {
			return inWindow;
		}
		return hourly.slice(0, forecastHours);
	}

	function calculateTierScores(hourly, options = {}) {
		const hours = selectHours(
			hourly,
			options.forecastHours ?? FORECAST_HOURS,
			options.window,
		);
		if (hours.length === 0) {
			throw new Error("Hourly forecast data is unavailable.");
		}

		const labels = sanitizeLabels(options.labels);
		const rainRisk = hours
			.slice(0, 6)
			.some((hour) => hour.precipitationProbability > 50);
		const effective = hours.map((hour) =>
			getEffectiveTemperature(hour, options),
		);
		// Nothing warmer exists to recommend, so the warmest available layer never loses score to cold.
		const warmestId = (
			CLOTHING_TIERS.find(
				(tier) =>
					options.available?.[tier.id] !== false,
			) || CLOTHING_TIERS[0]
		).id;

		const weightSum = effective.reduce(
			(total, _, index) => total + getHourWeight(index),
			0,
		);
		const averageEffective =
			effective.reduce(
				(total, temperature, index) =>
					total + temperature * getHourWeight(index),
				0,
			) / weightSum;

		const scores = CLOTHING_TIERS.map((tier) => {
			const plateauStart = tier.curve.find(
				([, value]) => value === 100,
			)[0];
			let weighted = 0;
			let totalWeight = 0;
			effective.forEach((temperature, index) => {
				const weight = getHourWeight(index);
				let score =
					tier.id === warmestId &&
					temperature < plateauStart
						? 100
						: interpolateScore(temperature, tier.curve);
				if (rainRisk) {
					score -= tier.rainPenalty;
				}
				weighted += clamp(score) * weight;
				totalWeight += weight;
			});
			return {
				...tier,
				label: labels[tier.id],
				score: Math.round(
					clamp(weighted / totalWeight),
				),
				layers:
					tier.id === warmestId
						? Math.round(
								clamp(
									(plateauStart - averageEffective) /
										LAYER_STEP_DEGREES,
									0,
									MAX_EXTRA_LAYERS,
								),
							)
						: 0,
			};
		});

		return { hours, rainRisk, scores };
	}

	function selectTopTier(scores) {
		return scores.reduce((best, tier) =>
			tier.score > best.score ? tier : best,
		);
	}

	function formatClock(isoOrMinutes) {
		const minutes =
			typeof isoOrMinutes === "number"
				? isoOrMinutes
				: hourStartMinutes(isoOrMinutes);
		const normalized = ((minutes % 1440) + 1440) % 1440;
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
	}

	function isSnowCode(code) {
		return (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
	}

	function classifyPrecipitation(hour) {
		if (
			hour.precipitation < PRECIP.wetMm ||
			hour.precipitationProbability < PRECIP.wetProbability
		) {
			return null;
		}
		if (hour.precipitation >= PRECIP.heavyMm) {
			return "heavy";
		}
		return hour.precipitation >= PRECIP.moderateMm
			? "moderate"
			: "light";
	}

	const SEVERITY_RANK = { light: 1, moderate: 2, heavy: 3 };

	// Groups consecutive wet hours into runs so alerts name exact time spans.
	function findPrecipitationAlerts(hours) {
		const alerts = [];
		let run = null;

		const flush = () => {
			if (!run) {
				return;
			}
			const noun = run.snow ? "snow" : "rain";
			const prefix =
				run.severity === "heavy"
					? `Heavy ${noun}`
					: run.severity === "light"
						? `Light ${noun}`
						: noun === "rain"
							? "Rain"
							: "Snow";
			const start = hourStartMinutes(run.hours[0].time);
			const end = start + run.hours.length * 60;
			alerts.push({
				severity: run.severity,
				kind: noun,
				start: formatClock(start),
				end: formatClock(end),
				hours: run.hours.length,
				totalMm: run.totalMm,
				sustained:
					run.hours.length >=
						PRECIP.sustainedHours ||
					run.severity === "heavy",
				message: `${prefix} expected ${formatClock(start)}\u2013${formatClock(end)}`,
			});
			run = null;
		};

		hours.forEach((hour, index) => {
			const severity = classifyPrecipitation(hour);
			const previous = hours[index - 1];
			const contiguous =
				previous &&
				(hourStartMinutes(previous.time) + 60) %
					1440 ===
					hourStartMinutes(hour.time);

			if (!severity || (run && !contiguous)) {
				flush();
			}
			if (!severity) {
				return;
			}
			if (!run) {
				run = {
					hours: [],
					severity,
					snow: false,
					totalMm: 0,
				};
			}
			run.hours.push(hour);
			run.totalMm += hour.precipitation;
			run.snow = run.snow || isSnowCode(hour.weatherCode);
			if (
				SEVERITY_RANK[severity] >
				SEVERITY_RANK[run.severity]
			) {
				run.severity = severity;
			}
		});
		flush();
		return alerts;
	}

	function getFootwearAdvice(alerts) {
		const sustained = alerts.find((alert) => alert.sustained);
		if (!sustained) {
			return null;
		}
		return {
			window: `${sustained.start}\u2013${sustained.end}`,
			recommend: "Water-resistant boots",
			avoid: "Canvas shoes",
			message: `Sustained ${sustained.kind} ${sustained.start}\u2013${sustained.end}: wear water-resistant boots, skip canvas shoes.`,
		};
	}

	function averageOf(values) {
		const numbers = values.filter(Number.isFinite);
		return numbers.length
			? numbers.reduce((total, value) => total + value, 0) /
					numbers.length
			: null;
	}

	function normalizeWeatherResponse(data, hoursKept = HOURS_KEPT) {
		if (
			!data ||
			!data.current ||
			!data.hourly ||
			!Array.isArray(data.hourly.time)
		) {
			throw new Error(
				"The weather service returned an incomplete forecast.",
			);
		}
		const h = data.hourly;
		const startIndex = Math.max(
			0,
			h.time.findIndex(
				(time) =>
					time >= data.current.time.slice(0, 13),
			),
		);

		const hourly = h.time
			.slice(startIndex, startIndex + hoursKept)
			.map((time, offset) => {
				const index = startIndex + offset;
				const temperature = toFiniteNumber(
					h.temperature_2m?.[index],
				);
				return {
					time,
					temperature,
					feelsLike: toFiniteNumber(
						h.apparent_temperature?.[index],
						temperature,
					),
					precipitationProbability:
						toFiniteNumber(
							h
								.precipitation_probability?.[
								index
							],
						),
					precipitation: toFiniteNumber(
						h.precipitation?.[index],
					),
					windSpeed: toFiniteNumber(
						h.wind_speed_10m?.[index],
					),
					weatherCode: toFiniteNumber(
						h.weather_code?.[index],
					),
				};
			});

		if (hourly.length < FORECAST_HOURS) {
			throw new Error(
				`A complete ${FORECAST_HOURS} hour forecast is not available yet.`,
			);
		}

		const c = data.current;
		const currentTemperature = toFiniteNumber(c.temperature_2m);
		return {
			current: {
				time: c.time,
				temperature: currentTemperature,
				feelsLike: toFiniteNumber(
					c.apparent_temperature,
					currentTemperature,
				),
				precipitation: toFiniteNumber(c.precipitation),
				windSpeed: toFiniteNumber(c.wind_speed_10m),
				weatherCode: toFiniteNumber(c.weather_code),
			},
			hourly,
			timezone: data.timezone,
			weekAverage: averageOf(
				(h.temperature_2m || []).slice(
					Math.max(0, startIndex - WEEK_HOURS),
					startIndex,
				),
			),
		};
	}

	/* ---------- settings & storage ---------- */

	function sanitizeLabels(labels) {
		const result = { ...DEFAULT_LABELS };
		Object.keys(DEFAULT_LABELS).forEach((key) => {
			const value =
				typeof labels?.[key] === "string"
					? labels[key]
							.trim()
							.slice(
								0,
								LABEL_MAX_LENGTH,
							)
					: "";
			if (value) {
				result[key] = value;
			}
		});
		return result;
	}

	// At least one tier must stay available so a recommendation always exists.
	function sanitizeAvailable(available) {
		const result = {};
		Object.keys(DEFAULT_LABELS).forEach((key) => {
			result[key] = available?.[key] !== false;
		});
		return Object.values(result).some(Boolean)
			? result
			: { hoodie: true, jumper: true, shirt: true };
	}

	function sanitizeComfort(value) {
		const rating = Math.round(
			toFiniteNumber(value, COMFORT_DEFAULT),
		);
		return clamp(rating, COMFORT_MIN, COMFORT_MAX);
	}

	// 1 = unbearable in the warmest layer (runs warm), 5 = never leaves without it (runs cold).
	function comfortToOffset(comfort) {
		return (
			(COMFORT_DEFAULT - sanitizeComfort(comfort)) *
			COMFORT_DEGREES_PER_STEP
		);
	}

	function sanitizeLocation(location) {
		const latitude = toFiniteNumber(location?.latitude, NaN);
		const longitude = toFiniteNumber(location?.longitude, NaN);
		if (
			!Number.isFinite(latitude) ||
			!Number.isFinite(longitude) ||
			Math.abs(latitude) > 90 ||
			Math.abs(longitude) > 180
		) {
			return null;
		}
		return {
			latitude,
			longitude,
			label:
				typeof location.label === "string" &&
				location.label
					? location.label.slice(0, 80)
					: "Saved location",
		};
	}

	function sanitizeSettings(raw) {
		const source = raw && typeof raw === "object" ? raw : {};
		const clock = (value) =>
			parseClock(value) === null ? "" : value;
		return {
			exposure:
				source.exposure in EXPOSURE_PROFILES
					? source.exposure
					: "short",
			thermalOffset: clamp(
				toFiniteNumber(source.thermalOffset),
				-THERMAL_OFFSET_LIMIT,
				THERMAL_OFFSET_LIMIT,
			),
			labels: sanitizeLabels(source.labels),
			comfort: sanitizeComfort(source.comfort),
			available: sanitizeAvailable(source.available),
			outWindow: {
				start: clock(source.outWindow?.start),
				end: clock(source.outWindow?.end),
			},
			geoPreference:
				source.geoPreference === "granted" ||
				source.geoPreference === "denied"
					? source.geoPreference
					: null,
			theme: source.theme === "light" ? "light" : "dark",
			location: sanitizeLocation(source.location),
		};
	}

	/*
	 * localStorage can throw (private mode, quota, disabled). Fall back to an
	 * in-memory map so the app keeps working for the session.
	 */
	function createStorage(getBackend) {
		const memory = new Map();
		let backend = null;
		try {
			backend = getBackend ? getBackend() : null;
			if (backend) {
				backend.setItem("shouldwear:probe", "1");
				backend.removeItem("shouldwear:probe");
			}
		} catch {
			backend = null;
		}

		return {
			persistent: Boolean(backend),
			getItem(key) {
				try {
					if (backend) {
						return backend.getItem(key);
					}
				} catch {
					// Fall through to memory.
				}
				return memory.has(key) ? memory.get(key) : null;
			},
			setItem(key, value) {
				memory.set(key, value);
				try {
					backend?.setItem(key, value);
				} catch {
					// Memory copy keeps the session consistent.
				}
			},
			removeItem(key) {
				memory.delete(key);
				try {
					backend?.removeItem(key);
				} catch {
					// Ignore.
				}
			},
		};
	}

	function loadSettings(storage) {
		try {
			return sanitizeSettings(
				JSON.parse(storage.getItem(SETTINGS_KEY)),
			);
		} catch {
			return sanitizeSettings(null);
		}
	}

	function saveSettings(storage, settings) {
		const clean = sanitizeSettings(settings);
		storage.setItem(SETTINGS_KEY, JSON.stringify(clean));
		return clean;
	}

	function locationKey(location) {
		return `${location.latitude.toFixed(2)},${location.longitude.toFixed(2)}`;
	}

	function saveWeatherCache(storage, location, weather, fetchedAt) {
		storage.setItem(
			WEATHER_CACHE_KEY,
			JSON.stringify({
				key: locationKey(location),
				fetchedAt,
				weather,
			}),
		);
	}

	function loadWeatherCache(storage, location) {
		try {
			const entry = JSON.parse(
				storage.getItem(WEATHER_CACHE_KEY),
			);
			if (
				entry &&
				entry.key === locationKey(location) &&
				Number.isFinite(entry.fetchedAt) &&
				entry.weather?.hourly
			) {
				return entry;
			}
		} catch {
			// Treat corrupt cache as missing.
		}
		return null;
	}

	function formatTimestamp(ms) {
		const date = new Date(ms);
		const pad = (value) => String(value).padStart(2, "0");
		return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	function debounce(fn, delay, timers = globalThis) {
		let handle = null;
		const wrapped = (...args) => {
			timers.clearTimeout(handle);
			handle = timers.setTimeout(() => {
				handle = null;
				fn(...args);
			}, delay);
		};
		wrapped.cancel = () => {
			timers.clearTimeout(handle);
			handle = null;
		};
		return wrapped;
	}

	return {
		CLOTHING_TIERS,
		DEFAULT_LABELS,
		DEFAULT_SETTINGS,
		EXPOSURE_PROFILES,
		FORECAST_HOURS,
		SETTINGS_KEY,
		THERMAL_OFFSET_LIMIT,
		WEATHER_CACHE_KEY,
		calculateTierScores,
		clamp,
		createStorage,
		debounce,
		filterHoursInWindow,
		findPrecipitationAlerts,
		formatClock,
		formatTimestamp,
		getEffectiveTemperature,
		getFootwearAdvice,
		getHourWeight,
		interpolateScore,
		loadSettings,
		loadWeatherCache,
		normalizeWeatherResponse,
		sanitizeLabels,
		sanitizeComfort,
		comfortToOffset,
		sanitizeSettings,
		saveSettings,
		saveWeatherCache,
		selectHours,
		selectTopTier,
		toFiniteNumber,
	};
});
