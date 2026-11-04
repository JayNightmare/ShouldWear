"use strict";

const CACHE_VERSION = "v16";
const STATIC_CACHE = `shouldwear-static-${CACHE_VERSION}`;
const API_CACHE = `shouldwear-api-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([STATIC_CACHE, API_CACHE]);
const APP_SHELL = [
	"./",
	"./index.html",
	"./privacy.html",
	"./terms.html",
	"./style.css",
	"./core.js",
	"./app.js",
	"./manifest.json",
	"./icons/icon-192.svg",
	"./icons/icon-512.svg",
	"./icons/twemoji-beach.svg",
	"./icons/twemoji-blossom.svg",
	"./icons/twemoji-tree.svg",
	"./icons/twemoji-leaf.svg",
	"./icons/twemoji-snowflake.svg",
];
const API_ORIGINS = new Set([
	"https://api.open-meteo.com",
	"https://nominatim.openstreetmap.org",
]);
const WEATHER_ORIGIN = "https://api.open-meteo.com";
const NETWORK_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(STATIC_CACHE)
			.then((cache) => cache.addAll(APP_SHELL))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((cacheNames) =>
				Promise.all(
					cacheNames
						.filter(
							(cacheName) =>
								!CURRENT_CACHES.has(
									cacheName,
								),
						)
						.map((cacheName) =>
							caches.delete(
								cacheName,
							),
						),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// Stamp a stored copy so the page can show when the data was fetched.
async function withTimestamp(response) {
	const headers = new Headers(response.headers);
	headers.set("x-sw-cached-at", String(Date.now()));
	return new Response(await response.blob(), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function storeLatest(cache, request, response, isWeather) {
	if (isWeather) {
		// Only the most recent forecast is kept.
		const keys = await cache.keys();
		await Promise.all(
			keys
				.filter(
					(key) =>
						new URL(key.url).origin ===
						WEATHER_ORIGIN,
				)
				.map((key) => cache.delete(key)),
		);
	}
	await cache.put(request, await withTimestamp(response));
}

async function networkFirst(request) {
	const cache = await caches.open(API_CACHE);
	const isWeather = new URL(request.url).origin === WEATHER_ORIGIN;

	const network = fetch(request).then(async (response) => {
		if (response.ok) {
			await storeLatest(
				cache,
				request,
				response.clone(),
				isWeather,
			);
		}
		return response;
	});

	network.catch(() => {});

	// Slow or failed network: answer from cache straight away when possible.
	const timeout = new Promise((resolve) =>
		setTimeout(
			() => resolve(cache.match(request)),
			NETWORK_TIMEOUT_MS,
		),
	);

	try {
		const first = await Promise.race([network, timeout]);
		return first || (await network);
	} catch (error) {
		const cachedResponse = await cache.match(request);
		if (cachedResponse) {
			return cachedResponse;
		}
		throw error;
	}
}

async function cacheFirst(request) {
	const cachedResponse = await caches.match(request);
	if (cachedResponse) {
		return cachedResponse;
	}

	try {
		const response = await fetch(request);
		if (response.ok || response.type === "opaque") {
			const cache = await caches.open(STATIC_CACHE);
			await cache.put(request, response.clone());
		}
		return response;
	} catch (error) {
		if (request.mode === "navigate") {
			const fallback = await caches.match("./index.html");
			if (fallback) {
				return fallback;
			}
		}
		throw error;
	}
}

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") {
		return;
	}

	const url = new URL(event.request.url);

	if (API_ORIGINS.has(url.origin)) {
		event.respondWith(networkFirst(event.request));
		return;
	}

	if (url.origin === self.location.origin) {
		event.respondWith(cacheFirst(event.request));
	}
});
