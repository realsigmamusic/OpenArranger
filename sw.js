const CACHE_NAME = '2.3.1';
const ASSETS = [
	'./',
	'./index.html',
	'./style.css',
	'./main.js',
	'./manifest.json',
	'./assets/maskable_icon_x512.png',
	'./assets/vendor/jszip.min.js',
	'./assets/Doto-Black.ttf'
];

self.addEventListener('install', (e) => {
	self.skipWaiting();
	e.waitUntil(
		caches.open(CACHE_NAME).then((cache) => {
			console.log('Arquivos em cache com sucesso!');
			return cache.addAll(ASSETS);
		})
	);
});

self.addEventListener('activate', (e) => {
	e.waitUntil(
		caches.keys().then((keyList) => {
			return Promise.all(
				keyList.map((key) => {
					// Deleta caches velhos se o CACHE_NAME mudou
					if (key !== CACHE_NAME) return caches.delete(key);
				})
			);
		})
	);
	self.clients.claim();
});

self.addEventListener('fetch', (e) => {
	// Ignora requisições de extensões do navegador ou coisas que não são GET
	if (e.request.method !== 'GET') return;

	// Cache Primeiro, Rede depois.
	e.respondWith(
		caches.match(e.request).then((cachedResponse) => {
			// Se achou no cache, retorna NA HORA.
			if (cachedResponse) {
				return cachedResponse; 
			}
			
			// Se não tem no cache, busca na internet (e já salva pro futuro)
			return fetch(e.request).then((networkResponse) => {
				return caches.open(CACHE_NAME).then((cache) => {
					cache.put(e.request, networkResponse.clone());
					return networkResponse;
				});
			}).catch((erro) => {
				console.error('Offline total e arquivo não encontrado no cache:', e.request.url);
			});
		})
	);
});