const TURSO_URL = 'https://jobs-db-mitsu.aws-ap-south-1.turso.io/v2/pipeline';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODcyOTA3NDUsImlkIjoiMDE5ZjhlZjUtN2MwMS03OTNhLWI4NWEtYmRkYzUxZjM1Mzk2Iiwia2lkIjoiNmNlY282ZndLZEdseG9IMzJ0ZU1Oc1hEX3gxU0xCQXMtQzZHYW1YTFZCUSIsInJpZCI6IjhiY2Q3YjQ2LWIwZDEtNDEzNC05YjMyLTZkM2MxYzdkNmU3NSJ9.7JgajPE4xibTALh94uAPyDpHs_Un_V0CZq4EzrF7o5rrtpWk1_xT2qoU0omyBVnrYT7I85h2oJxEjzKZuo3sDw';

async function queryTurso(sql, args = []) {
  const formattedArgs = args.map(a => ({ type: 'text', value: String(a) }));

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
    throw new Error(`Turso HTTP ${resp.status}: ${txt.slice(0, 200)}`);
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

  const urlObj = new URL(req.url || '/', 'http://localhost');
  const q = (req.query && req.query.q) || urlObj.searchParams.get('q') || '';
  const limit = (req.query && req.query.limit) || urlObj.searchParams.get('limit') || '24';
  const offset = (req.query && req.query.offset) || urlObj.searchParams.get('offset') || '0';
  const maxLimit = Math.min(parseInt(limit, 10) || 24, 100);
  const skipOffset = Math.max(parseInt(offset, 10) || 0, 0);

  try {
    let sql = `SELECT id, id as hash, title, company, location, COALESCE(description, '') as description, url, source, COALESCE(tags, '') as role_category, COALESCE(match_score, 0) as score, COALESCE(date, '') as created_at FROM unified_jobs WHERE 1=1`;
    const args = [];

    const qClean = String(q).trim().toLowerCase();
    if (qClean && qClean !== 'undefined' && qClean !== 'null') {
      const pattern = `%${qClean}%`;
      sql += ` AND (LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ?)`;
      args.push(pattern, pattern, pattern, pattern);
    }

    sql += ` ORDER BY COALESCE(date, id) DESC, id DESC LIMIT ${maxLimit} OFFSET ${skipOffset}`;

    const result = await queryTurso(sql, args);

    const jobs = (result.rows || []).map(row => ({
      id: row.id,
      hash: row.hash || row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      description: row.description,
      url: row.url,
      source: row.source,
      role_category: row.role_category,
      score: Number(row.score) || 0,
      created_at: row.created_at,
    }));

    return res.status(200).json({
      success: true,
      query: q,
      total: jobs.length,
      jobs: jobs,
    });
  } catch (dbError) {
    console.warn("Turso HTTP search error, trying Render fallback:", dbError);
  }

  // Fallback to Render Go API
  try {
    const fallbackResp = await fetch('https://job-search-api-go.onrender.com/jobs?limit=' + maxLimit, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (fallbackResp.ok) {
      const rawData = await fallbackResp.json();
      const rawJobs = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.jobs) ? rawData.jobs : []);
      let filtered = rawJobs;
      if (q) {
        const lowerQ = q.toLowerCase();
        filtered = rawJobs.filter(j =>
          (j.title && j.title.toLowerCase().includes(lowerQ)) ||
          (j.company && j.company.toLowerCase().includes(lowerQ)) ||
          (j.location && j.location.toLowerCase().includes(lowerQ))
        );
      }
      return res.status(200).json({
        success: true,
        query: q,
        total: filtered.length,
        jobs: filtered,
      });
    }
  } catch (fallbackError) {}

  return res.status(200).json({
    success: true,
    query: q,
    total: 0,
    jobs: [],
  });
}
