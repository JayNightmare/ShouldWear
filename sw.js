"use strict";

const CACHE_VERSION = "v2";
const STATIC_CACHE = `shouldwear-static-${CACHE_VERSION}`;
const API_CACHE = `shouldwear-api-${CACHE_VERSION}`;
const CURRENT_CACHES = new Set([STATIC_CACHE, API_CACHE]);
const APP_SHELL = [
	"./",
	"./index.html",
	"./style.css",
	"./app.js",
	"./manifest.json",
	"./icons/icon-192.svg",
	"./icons/icon-512.svg",
];
const API_ORIGINS = new Set([
	"https://api.open-meteo.com",
	"https://nominatim.openstreetmap.org",
]);
const FONT_HOSTS = new Set(["api.fontshare.com", "cdn.fontshare.com"]);

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

async function networkFirst(request) {
	const cache = await caches.open(API_CACHE);

	try {
		const response = await fetch(request);
		if (response.ok) {
			await cache.put(request, response.clone());
		}
		return response;
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

	if (
		url.origin === self.location.origin ||
		FONT_HOSTS.has(url.hostname)
	) {
		event.respondWith(cacheFirst(event.request));
	}
});
