// Phone notifications through ntfy (https://ntfy.sh): install the ntfy app, subscribe
// to a topic name, and set NTFY_TOPIC to the same name. Sent as JSON so coin names
// with emoji or other non-ASCII characters work.
export function createNotifier({ topic, server = 'https://ntfy.sh', onError = () => {} }) {
    if (!topic) return async () => {};
    return async ({ title, message, click, priority = 3, tags = [] }) => {
        try {
            const res = await fetch(server, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic, title, message, click, priority, tags })
            });
            if (!res.ok) onError(new Error(`ntfy HTTP ${res.status}`));
        } catch (e) {
            onError(e);
        }
    };
}

export const coinLink = mint => `https://pump.fun/coin/${mint}`;
