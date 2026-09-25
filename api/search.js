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

async function queryTurso(sql, args = []) {
  const token = getTursoToken();
  if (!token) {
    throw new Error("Missing Turso auth token in environment variables");
  }

  const formattedArgs = args.map(a => ({ type: 'text', value: String(a) }));

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
    throw new Error(`Turso HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (data.results && data.results[0] && data.results[0].error) {
    throw new Error(`Turso SQL Error: ${JSON.stringify(data.results[0].error)}`);
  }

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
      if (qClean.includes('analyst') || qClean.includes('data analyst')) {
        sql += ` AND (LOWER(title) LIKE ? OR LOWER(title) LIKE ? OR LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push('%data analyst%', '%business analyst%', '%bi engineer%', `%${qClean}%`, `%${qClean}%`, `%${qClean}%`);
      } else {
        const pattern = `%${qClean}%`;
        sql += ` AND (LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push(pattern, pattern, pattern, pattern);
      }
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

    if (jobs.length > 0) {
      return res.status(200).json({
        success: true,
        query: q,
        total: jobs.length,
        jobs: jobs,
      });
    }
  } catch (dbError) {
    console.warn("Turso search error, trying Render fallback:", dbError);
  }

  // Fallback to Koyeb Go API
  try {
    const fallbackResp = await fetch('https://typical-diana-mitsu96-df9a3fcc.koyeb.app/jobs?q=' + encodeURIComponent(q) + '&limit=' + maxLimit, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (fallbackResp.ok) {
      const rawData = await fallbackResp.json();
      const rawJobs = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.jobs) ? rawData.jobs : []);
      if (rawJobs.length > 0) {
        return res.status(200).json({
          success: true,
          query: q,
          total: rawJobs.length,
          fallback: 'render-go',
          jobs: rawJobs.map(j => ({
            id: j.id,
            hash: j.hash || j.id,
            title: j.title,
            company: j.company,
            location: j.location,
            description: j.description,
            url: j.url,
            source: j.source,
            role_category: Array.isArray(j.tags) ? j.tags.join(', ') : (j.role_category || j.tags || 'General Tech'),
            score: Number(j.match_score || j.score || 0),
            created_at: j.created_at || j.date || '',
          })),
        });
      }
    }
  } catch (fallbackError) {}

  return res.status(200).json({
    success: true,
    query: q,
    total: 0,
    jobs: [],
  });
}
