// CDN loader =====================================================================================
function loadScript(src) {
	return new Promise((resolve, reject) => {
		if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
		const s = document.createElement('script');
		s.src = src; s.onload = resolve; s.onerror = reject;
		document.head.appendChild(s);
	});
}

// Estado global inicial ===========================================================================
let audioCtx = null;
let isPlaying = false;
let bpm = 120;
let timerId = null;

// Cérebro Musical ================================================================================
let currentSection = 'Intro A';
let nextSection = 'Main A'; // o que vai tocar no próximo compasso
let quantization = 'half'; // 'measure' | 'half' | 'beat' | 'immediate'
let returnSection = 'Main A'; // memória do Break

const scheduleAheadTime = 0.1; // segundos à frente para agendar
const lookahead = 25.0; // intervalo do setTimeout em ms

// Data Layer =====================================================================================
const kitBuffers    = {}; // Rhythm: note → AudioBuffer
const kitBuffersSub = {}; // SubRhythm: note → AudioBuffer
let kits            = []; // array de { name, sfzNames, zip }
let activeKitIndex  = -1;
let activeSfzIndex    = 0; // SFZ ativo no select Rhythm
let activeSfzIndexSub = 0; // SFZ ativo no select SubRhythm
let kitLoaded         = false;
let kitLoadedSub      = false;
let kitName           = 'Load drumkit';
let kitNameSub        = 'Load drumkit';

// Styles: array de { name, styleData, styleMidiEvents, stylePPQ, beatsPerBar, beatType, drumChannels }
let styles = [];
let activeStyleIndex = -1; // índice do style ativo

// Atalhos para o style ativo (lidos dinamicamente via getters funcionais)
let styleData = null;
let styleMidiEvents = null;
let styleMidiEventsSub = null;
let stylePPQ = 480;
let beatsPerBar = 4;
let beatType = 4;
let styleLoaded = false;
let styleName = 'Load style';
let drumChannels    = [9];  // Rhythm  (canal 10 em 1-based → índice 9)
let drumChannelsSub = [8];  // SubRhythm (canal 9 em 1-based → índice 8)
let beatUnitFactor = 1; // fator de conversão: quantas semínimas vale 1 beat

function applyStyle(index) {
	if (isPlaying) {
		togglePlay(); // Para a música se estiver tocando
	}
	if (index < 0 || index >= styles.length) return;
	activeStyleIndex = index;
	const s = styles[index];
	styleData           = s.styleData;
	styleMidiEvents     = s.styleMidiEvents;
	styleMidiEventsSub  = s.styleMidiEventsSub ?? [];
	stylePPQ            = s.stylePPQ;
	beatsPerBar         = s.beatsPerBar;
	beatType            = s.beatType;
	beatUnitFactor      = s.beatUnitFactor ?? 1;
	drumChannels        = s.drumChannels;
	drumChannelsSub     = s.drumChannelsSub ?? [];
	styleLoaded = true;
	styleName = s.name;
	barLengthTicks = stylePPQ * (4 / beatType) * beatsPerBar;
	bpm = s.bpm;
	currentSection = 'Intro A';
	nextSection = 'Main A';
	updateUI();
	document.getElementById('bpm-display').value = bpm;
	setStatus(`Events ${styleMidiEvents.length} - PPQ ${stylePPQ} - Time ${beatsPerBar}/${beatType}`);
}

function updateStyleSelect(autoApply = true) {
	const sel = document.getElementById('style-select');
	const prev = sel.value;
	sel.innerHTML = '';
	if (styles.length === 0) {
		const opt = document.createElement('option');
		opt.value = '';
		opt.textContent = 'Load style';
		sel.appendChild(opt);
		return;
	}
	styles.forEach((s, i) => {
		const opt = document.createElement('option');
		opt.value = i;
		opt.textContent = s.name;
		sel.appendChild(opt);
	});
	// Mantém seleção ou vai pro último
	const newIdx = styles.findIndex((_, i) => String(i) === prev);
	sel.value = newIdx >= 0 ? newIdx : styles.length - 1;
	if (autoApply) applyStyle(parseInt(sel.value));
}

// Scheduler state ================================================================================
let barEvents    = null; // eventos Rhythm do compasso atual (relativeTick 0..barTicks-1)
let barEventsSub = null; // eventos SubRhythm do compasso atual
let barLengthTicks = 0; // duração de 1 compasso em ticks
let barStartTime = 0; // audioCtx.currentTime do início do compasso atual
let barTickOffset = 0; // tick atual dentro do compasso
let eventIndex    = 0; // próximo evento Rhythm a agendar em barEvents
let eventIndexSub = 0; // próximo evento SubRhythm a agendar em barEventsSub

// Flag: usuário clicou na seção ativa → repetir do compasso 1 na próxima transição
let _repeatCurrent = false;

// rAF loop para atualizar contadores nos botões
let _counterRafId = null;

// MIDI Parser (zero-dependency) ==================================================================
function parseMidi(buffer) {
	const data = new DataView(buffer);
	let pos = 0;

	const readUint16 = () => { const v = data.getUint16(pos); pos += 2; return v; };
	const readUint32 = () => { const v = data.getUint32(pos); pos += 4; return v; };
	const readByte = () => data.getUint8(pos++);
	const readVarLen = () => {
		let val = 0, b;
		do { b = readByte(); val = (val << 7) | (b & 0x7f); } while (b & 0x80);
		return val;
	};

	if (readUint32() !== 0x4D546864) throw new Error('Não é MIDI válido');
	readUint32(); // header length
	const format = readUint16();
	const numTracks = readUint16();
	const ppq = readUint16();
	const tracks = [];

	for (let t = 0; t < numTracks; t++) {
		if (readUint32() !== 0x4D54726B) throw new Error('Track inválida');
		const trackEnd = pos + readUint32();
		const events = [];
		let absTick = 0, running = 0;

		while (pos < trackEnd) {
			absTick += readVarLen();
			let status = data.getUint8(pos);
			if (status & 0x80) { running = status; pos++; } else { status = running; }

			const type = status & 0xf0;
			const ch = status & 0x0f;

			if (type === 0x90 || type === 0x80) {
				const note = readByte(), vel = readByte();
				if (type === 0x90 && vel > 0)
					events.push({ tick: absTick, note, velocity: vel, channel: ch });
			} else if (type === 0xa0 || type === 0xb0 || type === 0xe0) { pos += 2; }
			else if (type === 0xc0 || type === 0xd0)			 { pos += 1; }
			else if (status === 0xff) {
				readByte();
				const len = readVarLen();
				pos += len;
			}
			else if (status === 0xf0 || status === 0xf7) {
				const len = readVarLen();
				pos += len;
			}
			else { pos++; }
		}
		pos = trackEnd;
		tracks.push(events);
	}
	return { format, ppq, tracks };
}

function extractDrumEvents(midi, channels) {
	let events = [];
	for (const track of midi.tracks) {
		for (const ev of track) {
			if (channels.includes(ev.channel)) {
				events.push(ev);
			}
		}
	}
	return events.sort((a, b) => a.tick - b.tick);
}

// Conversões =====================================================================================
function barToTick(bar) {
	const ticksPerBeat = stylePPQ * (4 / beatType);
	return (bar - 1) * ticksPerBeat * beatsPerBar;
}
function ticksToSeconds(t) { return (t / stylePPQ) * (60 / bpm) / beatUnitFactor; }

// Eventos de uma seção ===========================================================================
function getSectionRange(sectionName) {
	const def = styleData?.sections?.[sectionName];
	if (!def) return null;
	const startTick = barToTick(def.startBar);
	const endTick = barToTick(def.endBar);
	return { startTick, endTick, lengthTicks: endTick - startTick };
}

function getBarEvents(sectionName, barIndex) {
	const range = getSectionRange(sectionName);
	if (!range || !styleMidiEvents) return [];

	const barStart = range.startTick + barIndex * barLengthTicks;
	const barEnd = barStart + barLengthTicks;

	return styleMidiEvents
	.filter(e => e.tick >= barStart && e.tick < barEnd)
	.map(e => ({ ...e, relativeTick: e.tick - barStart }));
}

function getBarEventsSub(sectionName, barIndex) {
	const range = getSectionRange(sectionName);
	if (!range || !styleMidiEventsSub) return [];

	const barStart = range.startTick + barIndex * barLengthTicks;
	const barEnd   = barStart + barLengthTicks;

	return styleMidiEventsSub
	.filter(e => e.tick >= barStart && e.tick < barEnd)
	.map(e => ({ ...e, relativeTick: e.tick - barStart }));
}

// Quantos compassos tem a seção?
function sectionBarCount(sectionName) {
	const range = getSectionRange(sectionName);
	if (!range) return 1;
	return Math.round(range.lengthTicks / barLengthTicks);
}

// Roteamento =====================================================================================
function autoRoute(section) {
	// Extrai a última letra isolada (ex: "A", "B"). Se não achar, assume "A"
	const match = section.match(/ ([A-Za-z])$/);
	const letter = match ? match[1] : 'A'; 

	if (section.startsWith('Fill In ') || section.startsWith('Intro '))
		return 'Main ' + letter;
	if (section === 'Break')
		return returnSection;
	if (section.startsWith('Ending '))
		return 'STOP';
	return section; // loop
}

// Scheduler ======================================================================================
let currentBarIndexInSection = 0;

function startBar(sectionName, barIndexInSection, startTime, entryTick = 0) {
	currentSection	 = sectionName;
	currentBarIndexInSection = barIndexInSection;
	// Em immediate, recua o barStartTime para que barTickOffset comece em entryTick
	barStartTime = startTime - ticksToSeconds(entryTick);
	barTickOffset = entryTick;
	eventIndex    = 0;
	eventIndexSub = 0;
	barEvents    = styleLoaded
		? getBarEvents(sectionName, barIndexInSection)
		: [];
	barEventsSub = styleLoaded
		? getBarEventsSub(sectionName, barIndexInSection)
		: [];
	// Pula eventos anteriores ao ponto de entrada
	while (eventIndex < barEvents.length &&
	 barEvents[eventIndex].relativeTick < entryTick) eventIndex++;
	while (eventIndexSub < barEventsSub.length &&
	 barEventsSub[eventIndexSub].relativeTick < entryTick) eventIndexSub++;

	if (sectionName.startsWith('Main ')) returnSection = sectionName;
	updateUI();
}

function scheduler() {
	if (!isPlaying) return;

	const horizon = audioCtx.currentTime + scheduleAheadTime;

	while (true) {
		const tickTime = barStartTime + ticksToSeconds(barTickOffset);
		if (tickTime >= horizon) break;

		// Dispara todos os eventos Rhythm que caem no tick atual
		while (eventIndex < barEvents.length &&
			barEvents[eventIndex].relativeTick <= barTickOffset) {
			const ev = barEvents[eventIndex++];
			const evT = barStartTime + ticksToSeconds(ev.relativeTick);
			triggerSample(ev.note, ev.velocity, evT);
		}
		// Dispara todos os eventos SubRhythm que caem no tick atual
		if (barEventsSub) {
			while (eventIndexSub < barEventsSub.length &&
				barEventsSub[eventIndexSub].relativeTick <= barTickOffset) {
				const ev = barEventsSub[eventIndexSub++];
				const evT = barStartTime + ticksToSeconds(ev.relativeTick);
				triggerSampleSub(ev.note, ev.velocity, evT);
			}
		}

		// Beat indicator: atualiza só quando o beat muda (evita rAF por tick)
		const ticksPerBeat = stylePPQ * (4 / beatType);
		const beat = Math.floor(barTickOffset / ticksPerBeat);
		const prevBeat = Math.floor((barTickOffset === 0 ? 0 : barTickOffset - 1) / ticksPerBeat);
		if (barTickOffset === 0 || beat !== prevBeat) {
			const displayBeat = beat + 1;
			const snapBar = currentBarIndexInSection + 1;
			const snapTotal = sectionBarCount(currentSection);
			requestAnimationFrame(() => {
				document.getElementById('beat-indicator').innerText = `${displayBeat}`;
				// Atualiza só o botão ativo, com valores capturados no momento exato
				const activeBtn = document.querySelector(`.grid-container .btn[data-section="${currentSection}"]`);
				if (activeBtn) {
					let counter = activeBtn.querySelector('.bar-counter');
					if (!counter) {
						counter = document.createElement('span');
						counter.className = 'bar-counter';
						activeBtn.appendChild(counter);
					}
					counter.textContent = `${snapTotal}|${snapBar}:${displayBeat}`;
				}
			});
		}

		// Verifica transição conforme quantização
		const userQueued = (nextSection !== currentSection) ? nextSection : null;
		const isMeasureEnd = barTickOffset + 1 >= barLengthTicks;
		const halfTicks = Math.floor(barLengthTicks / 2);
		const nextTick = barTickOffset + 1;
		const isHalfEnd = !isMeasureEnd && (nextTick % halfTicks === 0) && nextTick > 0;
		const isBeatEnd = !isMeasureEnd && !isHalfEnd && (nextTick % ticksPerBeat === 0) && nextTick > 0;
		const isImmediate = !isMeasureEnd && !isHalfEnd && !isBeatEnd;

		// Quantização só se aplica a Fills - todo o resto usa 'measure'
		const isFill = userQueued && userQueued.startsWith('Fill ');
		const activeQuant = isFill ? quantization : 'measure';

		// Decide se é hora de trocar agora
		const shouldTransition = isMeasureEnd || (
			userQueued && (
				(activeQuant === 'half' && isHalfEnd) ||
				(activeQuant === 'beat' && isBeatEnd) ||
				(activeQuant === 'immediate' && isImmediate)
			)
		);

		if (shouldTransition) {
			barTickOffset++;
			const cutTick = isMeasureEnd ? barLengthTicks : barTickOffset;
			const nextBarStart = barStartTime + ticksToSeconds(cutTick);

			if (_repeatCurrent) {
				// Repetição forçada: reinicia a seção atual do compasso 0
				_repeatCurrent = false;
				startBar(currentSection, 0, nextBarStart);
			} else if (userQueued) {
				if (userQueued === 'STOP') { scheduleStop(nextBarStart); return; }
				const entryTick = (isMeasureEnd || activeQuant === 'measure') ? 0 : cutTick;
				startBar(userQueued, 0, nextBarStart, entryTick);
			} else {
				const totalBars = sectionBarCount(currentSection);
				const nextBarIdx = currentBarIndexInSection + 1;

				if (nextBarIdx < totalBars) {
					startBar(currentSection, nextBarIdx, nextBarStart);
				} else {
					const auto = autoRoute(currentSection);
					if (auto === 'STOP') { scheduleStop(nextBarStart); return; }
					nextSection = auto;
					startBar(auto, 0, nextBarStart);
				}
			}
			// startBar já reiniciou barTickOffset; não incrementamos de novo
			continue;
		}

		// Salta direto para o tick do próximo evento (ou fim do compasso) em vez de ++1
		// Fix: considera o próximo evento de AMBOS os canais (Rhythm e SubRhythm),
		// caso contrário eventos SubRhythm entre dois eventos Rhythm são pulados e
		// disparam todos juntos atropelados no próximo tick Rhythm.
		const nextRhythmTick = eventIndex < barEvents.length
			? barEvents[eventIndex].relativeTick
			: barLengthTicks - 1;
		const nextSubTick = (barEventsSub && eventIndexSub < barEventsSub.length)
			? barEventsSub[eventIndexSub].relativeTick
			: barLengthTicks - 1;
		const nextEventTick = Math.min(nextRhythmTick, nextSubTick);

		// Próxima fronteira de quantização relevante
		let nextBoundary = barLengthTicks - 1; // padrão: fim do compasso
		if (userQueued) {
			if (activeQuant === 'half') {
				const nextHalf = Math.ceil((barTickOffset + 1) / halfTicks) * halfTicks - 1;
				nextBoundary = Math.min(nextBoundary, nextHalf);
			} else if (activeQuant === 'beat') {
				const nextBeatBoundary = Math.ceil((barTickOffset + 1) / stylePPQ) * stylePPQ - 1;
				nextBoundary = Math.min(nextBoundary, nextBeatBoundary);
			} else if (activeQuant === 'immediate') {
				nextBoundary = barTickOffset; // trata imediatamente
			}
		}

		// Próximo beat boundary para o indicador
		const nextBeatTick = (beat + 1) * ticksPerBeat;

		barTickOffset = Math.min(nextEventTick, nextBoundary, nextBeatTick, barLengthTicks - 1);
		// Se já estamos no tick calculado, avança 1 para não travar
		if (barTickOffset <= (nextTick - 1)) barTickOffset = nextTick;
	}

	timerId = setTimeout(scheduler, lookahead);
}

// Carregamento de arquivos =======================================================================
async function ensureJSZip() {
	if (window.JSZip) return;
	await loadScript('./assets/vendor/jszip.min.js');
}

async function loadKitFile(file) {
	await ensureJSZip();
	setStatus(`Carregando kit: ${file.name}...`);
	initAudio();

	const zip = await JSZip.loadAsync(file);
	const sfzNames = Object.keys(zip.files)
		.filter(f => f.endsWith('.sfz'))
		.sort();

	if (sfzNames.length === 0) { setStatus('Kit inválido: nenhum .sfz encontrado'); return; }

	const name  = file.name.replace(/\.kit$/i, '');
	const entry = { name, sfzNames, zip };

	const existing = kits.findIndex(k => k.name === name);
	let targetIndex;
	if (existing >= 0) { kits[existing] = entry; targetIndex = existing; }
	else               { kits.push(entry);        targetIndex = kits.length - 1; }

	updateKitSelect(targetIndex);
}

async function applyKit(kitIndex, sfzIndex = 0, role = 'rhythm') {
	if (kitIndex < 0 || kitIndex >= kits.length) return;

	const buffersObj = role === 'rhythm' ? kitBuffers : kitBuffersSub;
	activeKitIndex = kitIndex;
	if (role === 'rhythm') activeSfzIndex    = sfzIndex;
	else                   activeSfzIndexSub = sfzIndex;

	const kit      = kits[kitIndex];
	const sfzEntry = kit.zip.files[kit.sfzNames[sfzIndex]];
	if (!sfzEntry) return;

	Object.keys(buffersObj).forEach(k => delete buffersObj[k]);

	const mapping = parseSFZ(await sfzEntry.async('string'));
	let loaded = 0;

	for (const [note, path] of Object.entries(mapping)) {
		const targetName = path.replace(/\\/g, '/').split('/').pop().toLowerCase();
		const entryKey   = Object.keys(kit.zip.files).find(k => k.toLowerCase().endsWith(targetName));
		const entry      = kit.zip.files[entryKey];
		if (!entry) { console.warn('Sample não encontrado:', path); continue; }
		try {
			buffersObj[note] = await audioCtx.decodeAudioData(await entry.async('arraybuffer'));
			loaded++;
		} catch (e) { console.warn('Erro ao decodificar:', path, e); }
	}

	const label = `${kit.sfzNames[sfzIndex].replace(/\.sfz$/i, '').split('/').pop()}`;
	if (role === 'rhythm') { kitLoaded    = true; kitName    = label; }
	else                   { kitLoadedSub = true; kitNameSub = label; }
	setStatus(`${label} (${role}) - ${loaded} samples`);
}

function updateKitSelect(targetIndex = -1) {
	const selRhythm = document.getElementById('kit-select-rhythm');
	const selSub    = document.getElementById('kit-select-sub');
	selRhythm.innerHTML = '';
	selSub.innerHTML    = '';

	if (kits.length === 0) {
		for (const sel of [selRhythm, selSub]) {
			const opt = document.createElement('option');
			opt.value = ''; opt.textContent = 'Load kit';
			sel.appendChild(opt);
		}
		return;
	}

	// Coleta todas as opções em ordem alfabética por label
	const allOptions = [];
	kits.forEach((kit, ki) => {
		const sorted = kit.sfzNames
			.map((sfz, si) => ({
				ki, si,
				label: kit.sfzNames.length > 1
					? sfz.replace(/\.sfz$/i, '').split('/').pop()
					: kit.name
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		allOptions.push(...sorted);
	});

	for (const sel of [selRhythm, selSub]) {
		for (const { ki, si, label } of allOptions) {
			const opt = document.createElement('option');
			opt.value = `${ki}:${si}`;
			opt.textContent = label;
			sel.appendChild(opt);
		}
	}

	// Rhythm → primeiro SFZ; SubRhythm → segundo SFZ se existir, senão o mesmo
	const first  = allOptions[0];
	const second = allOptions.length > 1 ? allOptions[1] : allOptions[0];

	selRhythm.value = `${first.ki}:${first.si}`;
	selSub.value    = `${second.ki}:${second.si}`;
	applyKit(first.ki,  first.si,  'rhythm');
	applyKit(second.ki, second.si, 'sub');
}

function parseSFZ(text) {
	const mapping = {};

	// Remove comentários de linha
	text = text.replace(/\/\/.*/g, '');

	const blockRe = /<(\w+)>([^<]*)/g;
	let match;

	let globalOpcodes = {};
	let groupOpcodes  = {};

	// Parse opcodes de forma robusta: tokeniza por "palavra=" para não truncar
	// nomes de arquivo com espaços (ex: "Pop Latin Kit\Perc\Clave Wood.wav")
	function parseOpcodes(body) {
		const opcodes = {};
		const line = body.replace(/[\r\n]+/g, ' ');
		const keyRe = /\b(\w+)\s*=/g;
		const keys = [];
		let km;
		while ((km = keyRe.exec(line)) !== null) {
			keys.push({ key: km[1].toLowerCase(), valueStart: km.index + km[0].length });
		}
		for (let i = 0; i < keys.length; i++) {
			const start = keys[i].valueStart;
			const end   = i + 1 < keys.length ? keys[i + 1].valueStart - keys[i + 1].key.length - 1 : line.length;
			opcodes[keys[i].key] = line.slice(start, end).trim();
		}
		return opcodes;
	}

	while ((match = blockRe.exec(text)) !== null) {
		const blockType = match[1].toLowerCase();
		const body = match[2];
		const opcodes = parseOpcodes(body);

		if (blockType === 'global') { globalOpcodes = opcodes; continue; }
		if (blockType === 'group')  { groupOpcodes = { ...globalOpcodes, ...opcodes }; continue; }

		if (blockType === 'region') {
			const merged = { ...globalOpcodes, ...groupOpcodes, ...opcodes };
			const sample = merged['sample']?.replace(/['"]/g, '').trim();
			if (!sample) continue;

			let note = null;
			if (merged['key']             !== undefined) note = parseMidiNote(merged['key']);
			if (note === null && merged['pitch_keycenter'] !== undefined) note = parseMidiNote(merged['pitch_keycenter']);
			if (note === null && merged['lokey']          !== undefined) note = parseMidiNote(merged['lokey']);

			if (note !== null) mapping[note] = sample;
		}
	}

	return mapping;
}

// Converte nota MIDI: aceita número "36" ou nome "C2"
function parseMidiNote(val) {
	val = String(val).trim();
	const num = parseInt(val, 10);
	if (!isNaN(num)) return num;

	// Nome de nota: C-1, C#2, Db3, etc.
	const m = val.match(/^([A-Ga-g])([#b]?)([-]?\d+)$/);
	if (!m) return null;
	const noteMap = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
	const semitone = noteMap[m[1].toUpperCase()] + (m[2]==='#'?1: m[2]==='b'?-1:0);
	const octave = parseInt(m[3], 10);
	return (octave + 1) * 12 + semitone; // MIDI: C-1 = 0
}


// Figura de tempo para fator em semínimas ========================================================
function parseBeatUnit(val) {
	const s = String(val ?? 4).trim();
	const dotted = s.endsWith('.');
	const base = parseInt(s, 10);
	if (!base || base <= 0) return 1;
	let factor = 4 / base; // semínimas por beat
	if (dotted) factor *= 1.5; // pontuada = 1.5x
	return factor;
}

async function loadStyleFile(file) {
	await ensureJSZip();
	setStatus(`Carregando estilo: ${file.name}...`);

	const zip = await JSZip.loadAsync(file);
	const jsonEntry = Object.values(zip.files).find(f => f.name.endsWith('.json'));
	if (!jsonEntry) { setStatus('.json não encontrado'); return; }

	const sd = JSON.parse(await jsonEntry.async('string'));

	// Define os canais de bateria dinamicamente (1-based no JSON para facilitar)
	// Novo formato: { "Rhythm": 10, "subRhythm": 9 }
	// Retrocompatível com: { "drumChannel": 10 } ou { "drumChannel": [9,10] }
	let dc, dcSub;
	if (sd.Rhythm !== undefined || sd.subRhythm !== undefined) {
		dc    = sd.Rhythm    !== undefined ? [sd.Rhythm - 1]    : [9];
		dcSub = sd.subRhythm !== undefined ? [sd.subRhythm - 1] : [];
	} else if (sd.drumChannel !== undefined) {
		const arr = Array.isArray(sd.drumChannel)
			? sd.drumChannel.map(ch => ch - 1)
			: [sd.drumChannel - 1];
		dc    = [arr[0]];
		dcSub = arr.length > 1 ? [arr[1]] : [];
	} else {
		dc    = [9];
		dcSub = [8];
	}

	const midEntry = Object.values(zip.files).find(f => f.name.endsWith('.mid'));
	if (!midEntry) { setStatus('.mid não encontrado'); return; }

	const midi = parseMidi(await midEntry.async('arraybuffer'));
	const ppq = midi.ppq;
	const bpb = sd.timeSignature?.[0] ?? 4;
	const bt = sd.timeSignature?.[1] ?? 4;
	const buf = parseBeatUnit(sd.beatUnit); // beatUnitFactor: 1=semínima (default), 1.5=semínima pontuada, 0.5=colcheia...
	const events    = extractDrumEvents(midi, dc);
	const eventsSub = dcSub.length > 0 ? extractDrumEvents(midi, dcSub) : [];
	const sName = sd.name || file.name.replace(/\.style$/i, '');

	// Verifica se já existe um style com mesmo nome e substitui
	const existing = styles.findIndex(s => s.name === sName);
	const entry = { name: sName, styleData: sd, styleMidiEvents: events,
		styleMidiEventsSub: eventsSub,
		stylePPQ: ppq, beatsPerBar: bpb, beatType: bt, beatUnitFactor: buf,
		drumChannels: dc, drumChannelsSub: dcSub, bpm: sd.bpm || bpm };

	if (existing >= 0) {
		styles[existing] = entry;
	} else {
		styles.push(entry);
	}

	updateStyleSelect(false); // atualiza UI sem aplicar style
}

// Sample player ==================================================================================
let masterGain      = null;
let masterGainSub   = null;
let masterVolume    = 1.0;
let masterVolumeSub = 1.0;

function triggerSample(note, velocity, time) {
	if (!kitLoaded || !kitBuffers[note] || !masterGain) return;
	const src = audioCtx.createBufferSource();
	const gain = audioCtx.createGain();
	src.buffer = kitBuffers[note];
	const volume = Math.pow(velocity / 127, 2);
	gain.gain.setValueAtTime(volume, time);
	src.connect(gain);
	gain.connect(masterGain);
	src.start(time);
}

function triggerSampleSub(note, velocity, time) {
	if (!kitLoadedSub || !kitBuffersSub[note] || !masterGainSub) return;
	const src = audioCtx.createBufferSource();
	const gain = audioCtx.createGain();
	src.buffer = kitBuffersSub[note];
	const volume = Math.pow(velocity / 127, 2);
	gain.gain.setValueAtTime(volume, time);
	src.connect(gain);
	gain.connect(masterGainSub);
	src.start(time);
}

// Play / Stop ====================================================================================
function initAudio() {
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || window.webkitAudioContext)();
		masterGain = audioCtx.createGain();
		masterGain.gain.value = masterVolume;
		masterGain.connect(audioCtx.destination);
		masterGainSub = audioCtx.createGain();
		masterGainSub.gain.value = masterVolumeSub;
		masterGainSub.connect(audioCtx.destination);
	}
}

function togglePlay() {
	if (!styleLoaded) {
		setStatus('Carregue um estilo primeiro!');
		return;
	}
	initAudio();
	if (!isPlaying) {
		isPlaying = true;
		barLengthTicks = stylePPQ * (4 / beatType) * beatsPerBar; // garante inicializado
		nextSection = currentSection;
		startBar(currentSection, 0, audioCtx.currentTime + 0.05);
		document.getElementById('btn-play').innerText = 'Stop';
		document.getElementById('btn-play').classList.add('playing');
		scheduler();
		startCounterLoop();
	} else {
		isPlaying = false;
		clearTimeout(timerId);
		stopCounterLoop();
		document.getElementById('btn-play').innerText = 'Start';
		document.getElementById('btn-play').classList.remove('playing');
		document.getElementById('beat-indicator').innerText = '*';
	}
}

function scheduleStop(atTime) {
	const delay = Math.max(0, (atTime - audioCtx.currentTime) * 1000);
	setTimeout(() => {
		isPlaying = false;
		clearTimeout(timerId);
		stopCounterLoop();
		document.getElementById('btn-play').innerText = 'Start';
		document.getElementById('btn-play').classList.remove('playing');
		document.getElementById('beat-indicator').innerText = '*';
		updateUI();
	}, delay);
}

// Debug / Info ===================================================================================
function showDebugInfo() {
	if (!styleLoaded) { alert('Carregue um .style primeiro!'); return; }

	const totalBars = styleMidiEvents.length
	? Math.ceil(Math.max(...styleMidiEvents.map(e => e.tick)) / barLengthTicks)
	: '?';

	let info = `Nome: ${styleName}\n`;
	info += `PPQ: ${stylePPQ}\nFórmula de compasso: ${beatsPerBar}/${beatType}\nTicks por compasso: ${barLengthTicks}\n`;
	info += `Total de eventos: ${styleMidiEvents.length}\nCompassos no arquivo: ${totalBars}\n\n`;
	info += `${'-'.repeat(40)}\nSEÇÕES\n${'-'.repeat(40)}\n\n`;

	for (const [name, def] of Object.entries(styleData.sections || {})) {
		const startTick = barToTick(def.startBar);
		const endTick = barToTick(def.endBar);
		const bars = def.endBar - def.startBar;
		const evCount = styleMidiEvents.filter(e => e.tick >= startTick && e.tick < endTick).length;
		const flag = evCount === 0 ? ' vazia' : '';
		info += `${name.padEnd(10)} ${String(def.startBar).padStart(2, '0')}–${String(def.endBar).padStart(2, '0')} Length: ${bars} Notes: ${evCount}${flag}\n`;
	}

	document.getElementById('debug-info').innerText = info;
	document.getElementById('debug-modal').style.display = 'flex';
}

// UI =============================================================================================
function setStatus(msg) {
	document.getElementById('status-bar').innerText = msg;
}

function updateButtonAvailability() {
	document.querySelectorAll('.grid-container .btn').forEach(btn => {
		const sec = btn.dataset.section;
		const has = styleData?.sections?.[sec] != null;
		btn.disabled = !has;
		btn.style.opacity = has ? '1' : '0.3';
	});
}

function updateUI() {
	document.querySelectorAll('.grid-container .btn').forEach(b => {
		b.classList.remove('active', 'queued');
	});

	// Desabilita botões de seções que não existem no style atual
	document.querySelectorAll('.grid-container .btn[data-section]').forEach(btn => {
		const sec = btn.dataset.section;
		const exists = !styleLoaded || !!styleData?.sections?.[sec];
		btn.disabled = !exists;
		btn.classList.toggle('section-missing', !exists);
	});

	const activeBtn = document.querySelector(`.grid-container .btn[data-section="${currentSection}"]`);
	if (activeBtn) activeBtn.classList.add('active');

	const autoDest = autoRoute(currentSection);
	if (autoDest && autoDest !== currentSection && autoDest !== 'STOP') {
	    const autoBtn = document.querySelector(`.grid-container .btn[data-section="${autoDest}"]`);
	    if (autoBtn && !autoBtn.classList.contains('queued')) autoBtn.classList.add('queued');
	}

	if (nextSection !== currentSection && nextSection !== 'STOP') {
		const queuedBtn = document.querySelector(`.grid-container .btn[data-section="${nextSection}"]`);
		if (queuedBtn) queuedBtn.classList.add('queued');
	}

	updateSectionCounters();
}

// Contador de compasso nos botões ================================================================
function updateSectionCounters() {
	document.querySelectorAll('.grid-container .btn[data-section]').forEach(btn => {
		const sec = btn.dataset.section;

		let counter = btn.querySelector('.bar-counter');
		if (!counter) {
			counter = document.createElement('span');
			counter.className = 'bar-counter';
			btn.appendChild(counter);
		}

		if (!styleLoaded || !styleData?.sections?.[sec]) {
			counter.textContent = '';
			return;
		}

		const total = sectionBarCount(sec);
		if (sec === currentSection && isPlaying) {
			const ticksPerBeat = stylePPQ * (4 / beatType);
			const beat = Math.floor(barTickOffset / ticksPerBeat) + 1;
			counter.textContent = `${total}|${currentBarIndexInSection + 1}:${beat}`;
		} else {
			counter.textContent = `${total}`;
		}
	});
}

function startCounterLoop() {
	if (_counterRafId) return;
	const loop = () => {
		if (!isPlaying) { _counterRafId = null; return; }
		// Só botões inativos — o ativo é gerenciado pelo scheduler
		document.querySelectorAll('.grid-container .btn[data-section]').forEach(btn => {
			if (btn.dataset.section === currentSection) return;
			const sec = btn.dataset.section;
			let counter = btn.querySelector('.bar-counter');
			if (!counter) {
				counter = document.createElement('span');
				counter.className = 'bar-counter';
				btn.appendChild(counter);
			}
			counter.textContent = styleLoaded && styleData?.sections?.[sec]
				? `${sectionBarCount(sec)}`
				: '';
		});
		_counterRafId = requestAnimationFrame(loop);
	};
	_counterRafId = requestAnimationFrame(loop);
}

function stopCounterLoop() {
	if (_counterRafId) { cancelAnimationFrame(_counterRafId); _counterRafId = null; }
	updateSectionCounters();
}

// Tap Tempo ======================================================================================
const TAP_MAX_GAP = 2000; // reseta se passar mais de 2s entre taps
const TAP_MAX_SAMPLES = 8;
let tapTimes = [];

function processTap() {
	const now = performance.now();
	if (tapTimes.length > 0 && (now - tapTimes[tapTimes.length - 1]) > TAP_MAX_GAP) {
		tapTimes = [];
	}
	tapTimes.push(now);
	if (tapTimes.length > TAP_MAX_SAMPLES) tapTimes.shift();
	if (tapTimes.length < 2) { setStatus('Tap de novo para calcular BPM...'); return; }

	const gaps = [];
	for (let i = 1; i < tapTimes.length; i++) gaps.push(tapTimes[i] - tapTimes[i - 1]);
	const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
	const newBpm = Math.round(60000 / avgGap);
	bpm = Math.max(40, Math.min(250, newBpm));
	document.getElementById('bpm-display').value = bpm;
	setStatus(`Tap tempo: ${bpm} BPM`);
}

// Long-press no BPM +/- para incremento contínuo ================================================
function makeLongPress(btn, action) {
	let interval = null;
	let timeout = null;

	const start = () => {
		action();
		timeout = setTimeout(() => {
			interval = setInterval(action, 80);
		}, 400);
	};
	const stop = () => {
		clearTimeout(timeout);
		clearInterval(interval);
		timeout = null;
		interval = null;
	};

	btn.addEventListener('mousedown', start);
	btn.addEventListener('touchstart', e => { e.preventDefault(); start(); }, { passive: false });
	btn.addEventListener('mouseup', stop);
	btn.addEventListener('mouseleave', stop);
	btn.addEventListener('touchend', stop);
	btn.addEventListener('touchcancel', stop);
}

// Event listeners ================================================================================
document.getElementById('volume-slider-rhythm').addEventListener('input', e => {
	masterVolume = parseInt(e.target.value, 10) / 100;
	if (masterGain) masterGain.gain.value = masterVolume;
});
document.getElementById('volume-slider-sub').addEventListener('input', e => {
	masterVolumeSub = parseInt(e.target.value, 10) / 100;
	if (masterGainSub) masterGainSub.gain.value = masterVolumeSub;
});

document.getElementById('quantization').addEventListener('change', e => {
	quantization = e.target.value;
});
document.getElementById('btn-play').addEventListener('click', togglePlay);

const bpmInput = document.getElementById('bpm-display');

makeLongPress(document.getElementById('bpm-plus'), () => {
	bpm = Math.min(250, bpm + 1);
	bpmInput.value = bpm;
});

makeLongPress(document.getElementById('bpm-minus'), () => {
	bpm = Math.max(40, bpm - 1);
	bpmInput.value = bpm;
});

document.getElementById('beat-indicator').addEventListener('click', processTap);
document.getElementById('beat-indicator').title = 'Toque para fazer tap tempo';

bpmInput.addEventListener('change', (e) => {
	let val = parseInt(e.target.value, 10);
	if (isNaN(val)) val = 120;
	bpm = Math.max(40, Math.min(250, val));
	bpmInput.value = bpm;
});

document.getElementById('btn-load-kit').addEventListener('click', () => document.getElementById('input-kit').click());
document.getElementById('btn-add-style').addEventListener('click', () => document.getElementById('input-style').click());
document.getElementById('input-style').addEventListener('change', async e => {
	for (const file of e.target.files) {
		await loadStyleFile(file);
	}
	const manifest = [];
	for (let i = 0; i < styles.length; i++) {
		manifest.push(`style:${i}`);
	}
	const offset = styles.length - e.target.files.length;
	for (let j = 0; j < e.target.files.length; j++) {
		await dbSave(`style:${offset + j}`, e.target.files[j]);
	}
	await dbSave('style:manifest', manifest);
	await dbSave('style:active', activeStyleIndex);
	e.target.value = '';
	updateStyleSelect(true);
});
document.getElementById('style-select').addEventListener('change', async e => {
	const idx = parseInt(e.target.value);
	if (!isNaN(idx)) {
		applyStyle(idx);
		await dbSave('style:active', idx);
	}
});
document.getElementById('kit-select-rhythm').addEventListener('change', async e => {
	const [ki, si] = e.target.value.split(':').map(Number);
	if (!isNaN(ki)) await applyKit(ki, si, 'rhythm');
});
document.getElementById('kit-select-sub').addEventListener('change', async e => {
	const [ki, si] = e.target.value.split(':').map(Number);
	if (!isNaN(ki)) await applyKit(ki, si, 'sub');
});
document.getElementById('btn-debug').addEventListener('click', showDebugInfo);
document.getElementById('close-debug').addEventListener('click', () =>
document.getElementById('debug-modal').style.display = 'none');

document.getElementById('input-kit').addEventListener('change', async e => {
	const file = e.target.files[0];
	if (file) { await loadKitFile(file); await dbSave('kit', file); }
	e.target.value = '';
});

// Feedback tátil (mobile) ========================================================================
// Útil em palco: confirma o toque sem precisar olhar pra tela.
function vibrate(pattern) {
	if (navigator.vibrate) {
		try { navigator.vibrate(pattern); } catch (e) { /* navegador sem suporte real ao método */ }
	}
}

document.querySelectorAll('.grid-container .btn').forEach(btn => {
	btn.addEventListener('click', e => {
		const clicked = e.target.closest('[data-section]')?.dataset.section;
		if (!clicked) return;

		if (styleLoaded && !styleData?.sections?.[clicked]) return; // seção não existe neste style

		if (!isPlaying) {
			currentSection = clicked;
			nextSection = clicked;
			_repeatCurrent = false;
			if (clicked.startsWith('Main ')) returnSection = clicked;
			vibrate(10); // seleção simples, ainda parado
			updateUI();
			return;
		}

		if (clicked === currentSection) {
			// Clicou na seção ativa → agenda repetição do início
			_repeatCurrent = true;
			vibrate([10, 30, 10]); // pulso duplo: repetição enfileirada
			// Feedback visual: pisca o botão como queued
			btn.classList.add('queued');
		} else {
			_repeatCurrent = false;
			nextSection = clicked;
			if (clicked.startsWith('Ending ')) {
				vibrate([25, 50, 25, 50, 25]); // padrão mais forte: vai parar a música
			} else if (clicked.startsWith('Fill In ') || clicked === 'Break') {
				vibrate([15, 40, 15]); // transição especial
			} else {
				vibrate(12); // troca normal entre Main/Intro
			}
			updateUI();
		}
	});
});

// Persistência via IndexedDB =====================================================================
const DB_NAME = 'OpenArranger';
const DB_VERSION = 1;
const STORE = 'files';

// Singleton: abre a conexão uma única vez e reutiliza
let _dbPromise = null;
function openDB() {
	if (_dbPromise) return _dbPromise;
	_dbPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
		req.onsuccess = e => resolve(e.target.result);
		req.onerror = e => { _dbPromise = null; reject(e.target.error); };
	});
	return _dbPromise;
}

async function dbSave(key, blob) {
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(blob, key);
			tx.oncomplete = resolve;
			tx.onerror = e => reject(e.target.error);
		});
	} catch (e) { console.warn('dbSave falhou:', e); }
}

async function dbLoad(key) {
	try {
		const db = await openDB();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, 'readonly');
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = e => resolve(e.target.result ?? null);
			req.onerror = e => reject(e.target.error);
		});
	} catch (e) { console.warn('dbLoad falhou:', e); return null; }
}

async function restoreLastSession() {
	const [kitFile, styleManifest] = await Promise.all([
		dbLoad('kit'),
		dbLoad('style:manifest'),
	]);
	let restored = false;

	if (kitFile) {
		setStatus('Restaurando kit da última sessão...');
		await loadKitFile(kitFile);
		restored = true;
	}

	// Usa o manifesto explícito (lista de chaves) para restaurar styles sem while(true)
	const keys = Array.isArray(styleManifest) ? styleManifest : [];
	// Fallback: se não há manifesto, tenta varredura sequencial legada (compatibilidade)
	if (keys.length === 0) {
		let i = 0;
		let sf = await dbLoad(`style:${i}`);
		
		while (sf) {
			setStatus(`Restaurando style ${i + 1}...`);
			await loadStyleFile(sf);
			i++;
			sf = await dbLoad(`style:${i}`);
		}
		if (i > 0) restored = true;
	} else {
		for (const key of keys) {
			const sf = await dbLoad(key);
			if (!sf) continue;
			setStatus(`Restaurando style ${key}...`);
			await loadStyleFile(sf);
			restored = true;
		}
	}

	if (styles.length > 0) {
		const savedActive = await dbLoad('style:active');
		const targetIdx = (savedActive != null && savedActive < styles.length) ? savedActive : styles.length - 1;
		applyStyle(targetIdx);
		const sel = document.getElementById('style-select');
		sel.value = targetIdx;
	}

	if (!restored) setStatus('Carregue um .kit e um .style para começar.');
}

// Inicialização ==================================================================================
updateUI();
restoreLastSession();

// Versionamento dinâmico do app ==================================================================
async function loadAppVersion() {
    const res = await fetch('./sw.js');
    const text = await res.text();
    const match = text.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    if (match) document.getElementById('app-version').textContent = `v${match[1]}`;
}

loadAppVersion();