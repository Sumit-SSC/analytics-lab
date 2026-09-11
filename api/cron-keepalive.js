import { createClient } from '@libsql/client';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  let client = null;
  if (tursoUrl && tursoToken) {
    try {
      client = createClient({
        url: tursoUrl,
        authToken: tursoToken,
      });
    } catch (err) {
      console.error('Turso init error in keepalive:', err);
    }
  }

  // Determine current IST (Asia/Kolkata) time
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  });

  const parts = istFormatter.formatToParts(now);
  let hourStr = '0';
  let minStr = '0';
  for (const part of parts) {
    if (part.type === 'hour') hourStr = part.value;
    if (part.type === 'minute') minStr = part.value;
  }

  const hourIST = parseInt(hourStr, 10);
  const minIST = parseInt(minStr, 10);

  // Operational Window: 06:00 AM IST to 12:00 AM IST (00:00 IST) -> hours 6 through 23.
  const isOperationalWindow = hourIST >= 6;
  const nowISTStr = `${hourStr.padStart(2, '0')}:${minStr.padStart(2, '0')}`;

  if (!isOperationalWindow) {
    const nightMsg = `🌙 [NIGHT_REST_SKIP] Keep-Alive skipped at ${nowISTStr} IST (Operational window: 06:00 AM - 12:00 AM IST). Services resting.`;
    console.log(nightMsg);

    if (client) {
      try {
        await client.execute({
          sql: `INSERT INTO system_logs (level, component, message, details, created_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: ['INFO', 'VERCEL_KEEPALIVE', nightMsg, JSON.stringify({ status: 'NIGHT_REST', hourIST }), new Date().toISOString()]
        });
      } catch (logErr) {}
    }

    return new Response(
      JSON.stringify({
        success: true,
        service: 'analytics-lab-vercel-hub',
        task: 'cron-keepalive-5min',
        status: 'NIGHT_REST_SLEEP',
        ist_time: nowISTStr,
        message: 'Services allowed to sleep naturally between 00:00 and 06:00 IST'
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Operational Window Active (06:00 AM - 12:00 AM IST) -> Perform Keep-Alive Pings!
  console.log(`🌅 [ACTIVE_KEEP_ALIVE] Pinging Service 1 (Koyeb) and Service 2 (Render) at ${nowISTStr} IST...`);

  const s1Url = process.env.SERVICE_1_URL || 'https://typical-diana-mitsu96-df9a3fcc.koyeb.app/api/health';
  const s2Urls = [
    process.env.SERVICE_2_URL || 'https://job-search-api-go.onrender.com/health',
    'https://tg-jobs-engine.onrender.com/health'
  ];

  let s1Status = 'UNKNOWN';
  let s1Latency = 0;
  const s1Start = Date.now();

  try {
    const resp1 = await fetch(s1Url, { method: 'GET', headers: { 'User-Agent': 'Vercel-KeepAlive-Cron/1.0' } });
    s1Latency = Date.now() - s1Start;
    s1Status = resp1.ok ? `HTTP ${resp1.status} (${s1Latency}ms)` : `HTTP ${resp1.status}`;
  } catch (err1) {
    s1Status = `ERROR: ${err1.message}`;
  }

  let s2Status = 'UNKNOWN';
  let s2Latency = 0;
  const s2Start = Date.now();

  for (const s2Url of s2Urls) {
    try {
      const resp2 = await fetch(s2Url, { method: 'GET', headers: { 'User-Agent': 'Vercel-KeepAlive-Cron/1.0' } });
      s2Latency = Date.now() - s2Start;
      if (resp2.ok) {
        s2Status = `HTTP ${resp2.status} (${s2Latency}ms) via ${s2Url}`;
        break;
      } else {
        s2Status = `HTTP ${resp2.status} via ${s2Url}`;
      }
    } catch (err2) {
      s2Status = `ERROR: ${err2.message}`;
    }
  }

  const logMessage = `🟢 [KEEP_ALIVE_PING] ${nowISTStr} IST -> Service 1 (Koyeb): ${s1Status} | Service 2 (Render): ${s2Status}`;
  console.log(logMessage);

  if (client) {
    try {
      await client.execute({
        sql: `INSERT INTO system_logs (level, component, message, details, created_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          'INFO',
          'VERCEL_KEEPALIVE',
          logMessage,
          JSON.stringify({
            status: 'ACTIVE_PING',
            ist_time: nowISTStr,
            service1: s1Status,
            service2: s2Status,
            s1_latency_ms: s1Latency,
            s2_latency_ms: s2Latency
          }),
          new Date().toISOString()
        ]
      });
    } catch (logErr) {}
  }

  return new Response(
    JSON.stringify({
      success: true,
      service: 'analytics-lab-vercel-hub',
      task: 'cron-keepalive-5min',
      status: 'ACTIVE_PING_COMPLETED',
      ist_time: nowISTStr,
      service1_koyeb: s1Status,
      service2_render: s2Status
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
