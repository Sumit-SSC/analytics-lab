function getTursoEndpoint() {
  let url = process.env.TURSO_URL || process.env.TURSO_DATABASE_URL || 'https://jobs-db-mitsu.aws-ap-south-1.turso.io/v2/pipeline';
  url = url.replace(/^libsql:\/\//i, 'https://');
  if (!url.endsWith('/v2/pipeline')) {
    url = url.replace(/\/+$/, '') + '/v2/pipeline';
  }
  return url;
}

function getTursoToken() {
  return (process.env.TURSO_AUTH_TOKEN || process.env.DB_AUTH_TOKEN || process.env.TURSO_TOKEN || '').trim();
}

const defaultStats = {
  total_jobs: 24199,
  top_sources: [
    { source: 'feed - rssjobs.app', count: 21687 },
    { source: 'JobSpy LinkedIn', count: 638 },
    { source: 'RSSJobs.app', count: 250 },
    { source: 'RemoteOK', count: 145 },
    { source: 'WeWorkRemotely', count: 112 },
    { source: 'Naukri / Local ATS', count: 109 }
  ],
  top_categories: [
    { category: 'Data Analyst', count: 10127 },
    { category: 'Data Engineer', count: 4682 },
    { category: 'Developer', count: 7496 },
    { category: 'Data Scientist', count: 748 }
  ],
  status: 'ONLINE 🟢'
};

async function queryTurso(sql, args = []) {
  const token = getTursoToken();
  if (!token) {
    throw new Error("Missing Turso auth token in environment variables");
  }

  const formattedArgs = args.map(a => {
    if (typeof a === 'number') return { type: 'integer', value: String(a) };
    return { type: 'text', value: String(a) };
  });

  const resp = await fetch(getTursoEndpoint(), {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt: { sql, args: formattedArgs } }]
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Turso HTTP ${resp.status}: ${txt.slice(0, 100)}`);
  }

  const data = await resp.json();
  const resObj = data.results && data.results[0] && data.results[0].response && data.results[0].response.result;
  if (!resObj) return { cols: [], rows: [] };

  const cols = (resObj.cols || []).map(c => c.name);
  const rows = (resObj.rows || []).map(r => {
    const obj = {};
    cols.forEach((c, idx) => {
      obj[c] = (r[idx] && r[idx].value !== undefined && r[idx].value !== null) ? r[idx].value : null;
    });
    return obj;
  });

  return { cols, rows };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const cntRes = await queryTurso('SELECT COUNT(1) as cnt FROM unified_jobs');
    const totalJobs = (cntRes.rows && cntRes.rows.length > 0) ? Number(cntRes.rows[0].cnt) : 24199;

    const sourcesRes = await queryTurso('SELECT source, COUNT(1) as cnt FROM unified_jobs GROUP BY source ORDER BY cnt DESC LIMIT 6');
    const topSources = (sourcesRes.rows || []).map(r => ({
      source: r.source || 'Direct API',
      count: Number(r.cnt) || 0
    }));

    return res.status(200).json({
      success: true,
      total_jobs: totalJobs,
      top_sources: topSources.length > 0 ? topSources : defaultStats.top_sources,
      top_categories: defaultStats.top_categories,
      status: 'ONLINE 🟢',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.warn("Turso stats error, returning cached default stats:", err);
    return res.status(200).json({
      success: true,
      ...defaultStats,
      fallback: 'render-go',
      timestamp: new Date().toISOString()
    });
  }
}
