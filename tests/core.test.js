"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../core.js");

const hour = (time, overrides = {}) => ({
	time,
	temperature: 16,
	feelsLike: 16,
	precipitationProbability: 0,
	precipitation: 0,
	windSpeed: 5,
	weatherCode: 0,
	...overrides,
});

const day = (overrides = () => ({})) =>
	Array.from({ length: 24 }, (_, i) =>
		hour(
			`2026-11-02T${String(i).padStart(2, "0")}:00`,
			overrides(i),
		),
	);

const scoreOf = (result, id) => result.scores.find((t) => t.id === id).score;

test("interpolateScore clamps and interpolates", () => {
	const curve = [
		[0, 0],
		[10, 100],
	];
	assert.equal(core.interpolateScore(-5, curve), 0);
	assert.equal(core.interpolateScore(5, curve), 50);
	assert.equal(core.interpolateScore(20, curve), 100);
});

test("scoring keeps tier ids and picks the right tier", () => {
	const result = core.calculateTierScores(day(), { forecastHours: 6 });
	assert.deepEqual(
		result.scores.map((t) => t.id),
		["hoodie", "jumper", "shirt"],
	);
	assert.equal(core.selectTopTier(result.scores).id, "jumper");
});

test("wind speed is not scored separately (no double-counted chill)", () => {
	const calm = day(() => ({
		temperature: 10,
		feelsLike: 10,
		windSpeed: 5,
	}));
	const windy = day(() => ({
		temperature: 10,
		feelsLike: 10,
		windSpeed: 40,
	}));
	assert.deepEqual(
		core.calculateTierScores(calm, {}).scores.map((t) => t.score),
		core.calculateTierScores(windy, {}).scores.map((t) => t.score),
	);
});

test("prolonged exposure lowers effective temperature and light-layer scores", () => {
	const chilly = day(() => ({ temperature: 20, feelsLike: 17 }));
	const transit = core.getEffectiveTemperature(chilly[0], {
		exposure: "short",
	});
	const prolonged = core.getEffectiveTemperature(chilly[0], {
		exposure: "long",
	});
	assert.equal(transit, 17);
	assert.ok(Math.abs(prolonged - 13.7) < 1e-9); // 20 + (-3 * 1.6) - 1.5

	const a = core.calculateTierScores(chilly, { exposure: "short" });
	const b = core.calculateTierScores(chilly, { exposure: "long" });
	assert.ok(scoreOf(b, "shirt") <= scoreOf(a, "shirt"));
	assert.ok(scoreOf(b, "jumper") < scoreOf(a, "jumper"));
	assert.ok(scoreOf(b, "hoodie") > scoreOf(a, "hoodie"));
});

test("exposure does not amplify positive apparent difference", () => {
	const h = hour("2026-11-02T12:00", { temperature: 25, feelsLike: 28 });
	assert.equal(
		core.getEffectiveTemperature(h, { exposure: "short" }),
		28,
	);
	assert.equal(
		core.getEffectiveTemperature(h, { exposure: "long" }),
		26.5,
	);
});

test("thermal offset shifts scoring inputs only", () => {
	const data = day(() => ({ temperature: 16, feelsLike: 16 }));
	const snapshot = JSON.stringify(data);
	const cold = core.calculateTierScores(data, { thermalOffset: -4 });
	const base = core.calculateTierScores(data, {});
	const warm = core.calculateTierScores(data, { thermalOffset: 4 });
	assert.ok(scoreOf(cold, "hoodie") > scoreOf(base, "hoodie"));
	assert.ok(scoreOf(warm, "shirt") > scoreOf(base, "shirt"));
	assert.equal(
		JSON.stringify(data),
		snapshot,
		"raw temperatures untouched",
	);
	assert.equal(
		core.getEffectiveTemperature(data[0], { thermalOffset: 3 }),
		19,
	);
});

test("feeling cold never lowers the warmest available tier", () => {
	const data = day(() => ({ temperature: 11, feelsLike: 11 }));
	const base = core.calculateTierScores(data, {});
	const cold = core.calculateTierScores(data, { thermalOffset: -5 });
	assert.equal(scoreOf(cold, "hoodie"), scoreOf(base, "hoodie"));

	const noHoodie = { hoodie: false, jumper: true, shirt: true };
	const coldNoHoodie = core.calculateTierScores(data, {
		thermalOffset: -5,
		available: noHoodie,
	});
	const baseNoHoodie = core.calculateTierScores(data, {
		available: noHoodie,
	});
	assert.equal(
		scoreOf(coldNoHoodie, "jumper"),
		scoreOf(baseNoHoodie, "jumper"),
	);
});

test("the warmest available tier stays at 100 on a freezing day", () => {
	const freezing = day(() => ({ temperature: 0, feelsLike: -3 }));
	const result = core.calculateTierScores(freezing, {});
	assert.equal(scoreOf(result, "hoodie"), 100);
	assert.equal(scoreOf(result, "jumper"), 0);

	const noHoodie = core.calculateTierScores(freezing, {
		available: { hoodie: false, jumper: true, shirt: true },
	});
	assert.equal(scoreOf(noHoodie, "jumper"), 100);
});

test("extra layers grow as it gets colder, capped at 3", () => {
	const layersAt = (temperature, available) =>
		core
			.calculateTierScores(
				day(() => ({
					temperature,
					feelsLike: temperature,
				})),
				{ available },
			)
			.scores.map((t) => t.layers);
	assert.deepEqual(layersAt(12), [0, 0, 0]);
	assert.deepEqual(layersAt(6), [1, 0, 0]);
	assert.deepEqual(layersAt(3), [2, 0, 0]);
	assert.deepEqual(layersAt(-20), [3, 0, 0]);
	assert.deepEqual(
		layersAt(2, { hoodie: false, jumper: true, shirt: true }),
		[0, 3, 0],
	);
});

test("custom labels change display only", () => {
	const result = core.calculateTierScores(day(), {
		labels: { hoodie: "  Parka ", shirt: "" },
	});
	assert.equal(result.scores[0].label, "Parka");
	assert.equal(result.scores[0].id, "hoodie");
	assert.equal(result.scores[2].label, "T-Shirt");
});

test("out-of-house window filters hours, including overnight", () => {
	const data = day();
	const work = core.filterHoursInWindow(data, {
		start: "09:00",
		end: "12:30",
	});
	assert.deepEqual(
		work.map((h) => h.time.slice(11)),
		["09:00", "10:00", "11:00", "12:00"],
	);
	const night = core.filterHoursInWindow(data, {
		start: "22:00",
		end: "01:00",
	});
	assert.deepEqual(
		night.map((h) => h.time.slice(11, 13)),
		["00", "22", "23"],
	);
	assert.equal(
		core.filterHoursInWindow(data, { start: "", end: "" }),
		data,
	);
});

test("window drives scored hours and falls back when empty", () => {
	const data = day((i) =>
		i >= 9 && i < 12 ? { temperature: 2, feelsLike: 2 } : {},
	);
	const windowed = core.calculateTierScores(data, {
		window: { start: "09:00", end: "12:00" },
	});
	assert.equal(windowed.hours.length, 3);
	assert.equal(core.selectTopTier(windowed.scores).id, "hoodie");
	const short = data.slice(0, 3);
	assert.equal(
		core.calculateTierScores(short, {
			window: { start: "20:00", end: "22:00" },
		}).hours.length,
		3,
	);
});

test("precipitation alerts name the exact hours", () => {
	const data = day((i) =>
		i === 14
			? {
					precipitation: 5,
					precipitationProbability: 90,
					weatherCode: 65,
				}
			: {},
	);
	const alerts = core.findPrecipitationAlerts(
		core.filterHoursInWindow(data, {
			start: "08:00",
			end: "18:00",
		}),
	);
	assert.equal(alerts.length, 1);
	assert.equal(alerts[0].message, "Heavy rain expected 14:00\u201315:00");
});

test("alerts ignore wet hours outside the window and low-probability drizzle", () => {
	const data = day((i) =>
		i === 20
			? { precipitation: 3, precipitationProbability: 90 }
			: i === 10
				? {
						precipitation: 1,
						precipitationProbability: 10,
					}
				: {},
	);
	const inWindow = core.filterHoursInWindow(data, {
		start: "08:00",
		end: "18:00",
	});
	assert.deepEqual(core.findPrecipitationAlerts(inWindow), []);
});

test("consecutive wet hours merge; gaps split", () => {
	const wet = { precipitation: 1.5, precipitationProbability: 80 };
	const data = day((i) => ([9, 10, 11, 15].includes(i) ? wet : {}));
	const alerts = core.findPrecipitationAlerts(data);
	assert.deepEqual(
		alerts.map((a) => [a.start, a.end, a.sustained]),
		[
			["09:00", "12:00", true],
			["15:00", "16:00", false],
		],
	);
	assert.equal(alerts[0].message, "Rain expected 09:00\u201312:00");
});

test("footwear warning only for sustained precipitation", () => {
	const wet = { precipitation: 1.5, precipitationProbability: 80 };
	const single = core.findPrecipitationAlerts(
		day((i) => (i === 9 ? wet : {})),
	);
	assert.equal(core.getFootwearAdvice(single), null);
	const sustained = core.findPrecipitationAlerts(
		day((i) => (i === 9 || i === 10 ? wet : {})),
	);
	const advice = core.getFootwearAdvice(sustained);
	assert.match(advice.recommend, /water-resistant boots/i);
	assert.match(advice.avoid, /canvas/i);
});

test("integration: raw Open-Meteo payload to scores and alerts", () => {
	const time = Array.from(
		{ length: 48 },
		(_, i) =>
			`2026-11-0${2 + Math.floor(i / 24)}T${String(i % 24).padStart(2, "0")}:00`,
	);
	const fill = (fn) => time.map((_, i) => fn(i));
	const weather = core.normalizeWeatherResponse({
		timezone: "Europe/London",
		current: {
			time: "2026-11-02T08:45",
			temperature_2m: 9,
			apparent_temperature: 6,
		},
		hourly: {
			time,
			temperature_2m: fill(() => 9),
			apparent_temperature: fill(() => 6),
			precipitation: fill((i) =>
				i === 14 || i === 15 ? 2 : 0,
			),
			precipitation_probability: fill(() => 70),
		},
	});
	assert.equal(weather.hourly[0].time, "2026-11-02T08:00");
	assert.equal(weather.hourly.length, 24);
	const result = core.calculateTierScores(weather.hourly, {
		window: { start: "13:00", end: "17:00" },
		exposure: "long",
	});
	const alerts = core.findPrecipitationAlerts(result.hours);
	assert.equal(alerts[0].message, "Rain expected 14:00\u201316:00");
	assert.ok(core.getFootwearAdvice(alerts));
	assert.throws(() => core.normalizeWeatherResponse({}), /incomplete/);
});

test("settings sanitise bad input", () => {
	const s = core.sanitizeSettings({
		exposure: "weird",
		thermalOffset: 99,
		labels: { hoodie: "x".repeat(60), jumper: 5 },
		outWindow: { start: "25:00", end: "18:30" },
		geoPreference: "maybe",
		location: { latitude: 500, longitude: 0 },
	});
	assert.equal(s.exposure, "short");
	assert.equal(s.thermalOffset, 5);
	assert.equal(s.labels.hoodie.length, 24);
	assert.equal(s.labels.jumper, "Light Jumper");
	assert.deepEqual(s.outWindow, { start: "", end: "18:30" });
	assert.equal(s.geoPreference, null);
	assert.equal(s.location, null);
});

function fakeBackend() {
	const data = new Map();
	return {
		getItem: (k) => (data.has(k) ? data.get(k) : null),
		setItem: (k, v) => data.set(k, String(v)),
		removeItem: (k) => data.delete(k),
	};
}

test("settings persist across reloads", () => {
	const backend = fakeBackend();
	core.saveSettings(
		core.createStorage(() => backend),
		{
			exposure: "long",
			thermalOffset: -2.5,
			labels: { hoodie: "Parka" },
			geoPreference: "granted",
		},
	);
	const loaded = core.loadSettings(core.createStorage(() => backend));
	assert.equal(loaded.exposure, "long");
	assert.equal(loaded.thermalOffset, -2.5);
	assert.equal(loaded.labels.hoodie, "Parka");
	assert.equal(loaded.geoPreference, "granted");
});

test("storage falls back to memory when localStorage throws", () => {
	const broken = {
		getItem() {
			throw new Error("denied");
		},
		setItem() {
			throw new Error("quota");
		},
		removeItem() {
			throw new Error("denied");
		},
	};
	const storage = core.createStorage(() => broken);
	assert.equal(storage.persistent, false);
	core.saveSettings(storage, { thermalOffset: 3 });
	assert.equal(core.loadSettings(storage).thermalOffset, 3);
	const none = core.createStorage(() => {
		throw new Error("no localStorage");
	});
	assert.equal(core.loadSettings(none).exposure, "short");
});

test("corrupt stored JSON yields defaults", () => {
	const backend = fakeBackend();
	backend.setItem(core.SETTINGS_KEY, "{not json");
	const loaded = core.loadSettings(core.createStorage(() => backend));
	assert.deepEqual(loaded.labels, core.DEFAULT_LABELS);
	assert.equal(loaded.thermalOffset, 0);
});

test("weather cache is keyed by location", () => {
	const storage = core.createStorage(() => fakeBackend());
	const here = { latitude: 51.5, longitude: -0.12 };
	core.saveWeatherCache(storage, here, { hourly: [1] }, 1700000000000);
	assert.equal(
		core.loadWeatherCache(storage, here).fetchedAt,
		1700000000000,
	);
	assert.equal(
		core.loadWeatherCache(storage, { latitude: 40, longitude: 3 }),
		null,
	);
});

test("debounce collapses rapid calls", async () => {
	const calls = [];
	const d = core.debounce((v) => calls.push(v), 20);
	d("a");
	d("b");
	d("c");
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(calls, ["c"]);
	d("x");
	d.cancel();
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(calls, ["c"]);
});
