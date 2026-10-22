import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, coinLink } from '../notify.js';

test('notifier posts ntfy JSON, does nothing without a topic and never throws', async () => {
    const sent = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; };
    try {
        await createNotifier({ topic: '' })({ title: 'x', message: 'y' });
        assert.equal(sent.length, 0);

        await createNotifier({ topic: 'my-topic' })({ title: 'ENTRY: 🐸 PEPE…', message: 'run 240%', click: coinLink('Abcpump'), priority: 5, tags: ['rotating_light'] });
        assert.deepEqual(sent[0], {
            url: 'https://ntfy.sh',
            body: { topic: 'my-topic', title: 'ENTRY: 🐸 PEPE…', message: 'run 240%', click: 'https://pump.fun/coin/Abcpump', priority: 5, tags: ['rotating_light'] }
        });

        const errors = [];
        globalThis.fetch = async () => { throw new Error('offline'); };
        await createNotifier({ topic: 't', onError: e => errors.push(e.message) })({ title: 'x', message: 'y' });
        assert.deepEqual(errors, ['offline']);
    } finally {
        globalThis.fetch = realFetch;
    }
});
