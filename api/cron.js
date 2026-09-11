import keepaliveHandler from './cron-keepalive.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: 'numeric',
    minute: 'numeric'
  });

  const parts = istFormatter.formatToParts(now);
  let hourStr = '0';
  let minStr = '0';
  for (const part of parts) {
    if (part.type === 'hour') hourStr = part.value;
    if (part.type === 'minute') minStr = part.value;
  }

  let keepaliveResult = null;
  try {
    const kaResp = await keepaliveHandler(req);
    keepaliveResult = await kaResp.json();
  } catch (err) {
    keepaliveResult = { error: err.message };
  }

  return new Response(
    JSON.stringify({
      success: true,
      service: 'analytics-lab-vercel-hub',
      task: 'unified-master-cron-5min',
      timestamp: new Date().toISOString(),
      ist_time: `${hourStr.padStart(2, '0')}:${minStr.padStart(2, '0')}`,
      keepalive: keepaliveResult
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
