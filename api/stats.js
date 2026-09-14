const TURSO_URL = 'https://jobs-db-mitsu.aws-ap-south-1.turso.io/v2/pipeline';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODcyOTA3NDUsImlkIjoiMDE5ZjhlZjUtN2MwMS03OTNhLWI4NWEtYmRkYzUxZjM1Mzk2Iiwia2lkIjoiNmNlY282ZndLZEdseG9IMzJ0ZU1Oc1hEX3gxU0xCQXMtQzZHYW1YTFZCUSIsInJpZCI6IjhiY2Q3YjQ2LWIwZDEtNDEzNC05YjMyLTZkM2MxYzdkNmU3NSJ9.7JgajPE4xibTALh94uAPyDpHs_Un_V0CZq4EzrF7o5rrtpWk1_xT2qoU0omyBVnrYT7I85h2oJxEjzKZuo3sDw';

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
  const formattedArgs = args.map(a => {
    if (typeof a === 'number') return { type: 'integer', value: String(a) };
    return { type: 'text', value: String(a) };
  });

  const resp = await fetch(TURSO_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + TURSO_TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const totalJobsRes = await queryTurso('SELECT COUNT(1) as total FROM unified_jobs');
    const totalJobs = (totalJobsRes.rows && totalJobsRes.rows[0]) ? Number(totalJobsRes.rows[0].total) : defaultStats.total_jobs;

    const sourcesRes = await queryTurso('SELECT source, COUNT(1) as count FROM unified_jobs GROUP BY source ORDER BY count DESC LIMIT 10');
    let sources = (sourcesRes.rows || []).map(r => ({ source: String(r.source), count: Number(r.count) }));
    if (!sources || sources.length === 0) {
      sources = defaultStats.top_sources;
    }

    return res.status(200).json({
      success: true,
      service: 'service-3-vercel-hub',
      timestamp: new Date().toISOString(),
      stats: {
        total_jobs: Number(totalJobs),
        top_sources: sources,
        status: 'ONLINE 🟢',
      },
    });
  } catch (err) {
    console.warn("Turso DB stats error, using defaultStats:", err);
    return res.status(200).json({
      success: true,
      service: 'service-3-vercel-hub',
      timestamp: new Date().toISOString(),
      stats: defaultStats,
    });
  }
}
