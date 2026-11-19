'use strict';
'require baseclass';
'require fs';
'require rpc';

/* Read-only collectors. Select once per page: nlbwmon first, then existing nft
 * counters. A selected collector's failure must never silently change sources. */
const callConfig = rpc.declare({ object: 'uci', method: 'get', params: ['config'], expect: { values: {} } });
let config = null, configAt = 0, selected = null, retryAt = 0;

function interval(values) {
	const sections = Object.values(values || {}).filter((s) => s && s['.type'] === 'nlbwmon');
	if (sections.length !== 1) return null;
	const m = /^(\d+)([smhdw]?)$/.exec(String(sections[0].refresh_interval == null ? '30s' : sections[0].refresh_interval));
	if (!m) return null;
	const seconds = Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 })[m[2]];
	return seconds > 0 && seconds <= 2147483 ? Math.max(5, seconds) : null;
}

async function nlbwSample() {
	const now = Date.now();
	if (!config || now - configAt >= 300000) {
		config = await callConfig('nlbwmon');
		configAt = now;
	}
	const seconds = interval(config);
	if (seconds == null) return null;
	const result = await fs.exec_direct('/usr/sbin/nlbw', ['-c', 'json', '-g', 'mac', '-n'], 'json');
	if (!result || !Array.isArray(result.columns) || !Array.isArray(result.data)) return null;
	const fields = ['mac', 'rx_bytes', 'tx_bytes'].map((key) => result.columns.indexOf(key));
	if (fields.some((i) => i < 0) || result.data.some((row) => !Array.isArray(row) ||
		fields.slice(1).some((i) => !Number.isSafeInteger(row[i]) || row[i] < 0))) return null;
	return { source: 'nlbwmon', interval: seconds, columns: result.columns, data: result.data };
}

async function nftSample() {
	// Query only named counters, not the potentially large ruleset or sets.
	const result = await fs.exec_direct('/usr/sbin/nft', ['-j', 'list', 'counters', 'table', 'inet', 'carbon_acct'], 'json');
	if (!result || !Array.isArray(result.nftables)) return null;
	const devices = new Map();
	for (const entry of result.nftables) {
		const c = entry && entry.counter;
		if (!c || c.family !== 'inet' || c.table !== 'carbon_acct') continue;
		const m = /^carbon_(down|up)_([0-9a-f]{12})$/.exec(c.name || '');
		if (!m || m[2] === '000000000000') continue;
		const mac = m[2].match(/../g).join(':');
		const d = devices.get(mac) || {};
		// A bad device must not suppress other devices' valid counters.
		if (!Number.isSafeInteger(c.bytes) || c.bytes < 0 || d[m[1]] != null) d.invalid = true;
		d[m[1]] = c;
		devices.set(mac, d);
	}
	const data = [];
	devices.forEach((d, mac) => {
		if (d.invalid || !d.down || !d.up) return;
		// Object recreation invalidates only this device's baseline.
		const identity = JSON.stringify([d.down.handle ?? null, d.up.handle ?? null]);
		data.push([mac, d.down.bytes, d.up.bytes, identity]);
	});
	if (!data.length) return null;
	return { source: 'nftables', interval: 5, columns: ['mac', 'rx_bytes', 'tx_bytes', 'identity'], data };
}

return baseclass.extend({
	async read() {
		if (selected) return selected();
		if (Date.now() < retryAt) return null;
		for (const read of [nlbwSample, nftSample]) {
			try {
				const sample = await read();
				if (sample) { selected = read; return sample; }
			} catch (e) { /* Unavailable during discovery: try the next collector. */ }
		}
		// Failed discovery is independent of either collector's sampling interval.
		config = null;
		retryAt = Date.now() + 60000;
		return null;
	}
});
