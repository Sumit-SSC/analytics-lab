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
  const location = (req.query && req.query.location) || urlObj.searchParams.get('location') || '';
  const role = (req.query && req.query.role) || urlObj.searchParams.get('role') || '';
  const limit = (req.query && req.query.limit) || urlObj.searchParams.get('limit') || '60';
  const offset = (req.query && req.query.offset) || urlObj.searchParams.get('offset') || '0';

  const maxLimit = Math.min(parseInt(limit, 10) || 60, 500);
  const skipOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let primaryError = '';
  let countError = '';
  let fallbackError = '';
  let jobs = [];
  let totalCount = 0;

  try {
    try {
      const countRes = await queryTurso('SELECT COUNT(1) as cnt FROM unified_jobs');
      if (countRes.rows && countRes.rows.length > 0) {
        totalCount = Number(countRes.rows[0].cnt) || 0;
      }
    } catch (cntErr) {
      countError = String(cntErr.message || cntErr);
    }

    let sql = `SELECT id, id as hash, title, company, location, COALESCE(description, '') as description, url, source, COALESCE(tags, '') as role_category, COALESCE(match_score, 0) as score, COALESCE(date, '') as created_at FROM unified_jobs WHERE 1=1`;
    const args = [];

    const locClean = String(location).trim().toLowerCase();
    if (locClean && locClean !== 'all' && locClean !== 'undefined' && locClean !== 'null') {
      sql += ` AND (LOWER(location) LIKE ? OR LOWER(title) LIKE ? OR LOWER(description) LIKE ?)`;
      const locPattern = `%${locClean}%`;
      args.push(locPattern, locPattern, locPattern);
    }

    const roleClean = String(role).trim().toLowerCase();
    if (roleClean && roleClean !== 'all' && roleClean !== 'undefined' && roleClean !== 'null') {
      if (roleClean.includes('analyst') || roleClean.includes('data_analyst')) {
        sql += ` AND (LOWER(title) LIKE ? OR LOWER(title) LIKE ? OR LOWER(title) LIKE ? OR LOWER(title) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push('%data analyst%', '%business analyst%', '%bi engineer%', '%analytics engineer%', '%analyst%', '%data analyst%');
      } else {
        sql += ` AND (LOWER(title) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(description) LIKE ?)`;
        const rolePattern = `%${roleClean}%`;
        args.push(rolePattern, rolePattern, rolePattern);
      }
    }

    sql += ` ORDER BY COALESCE(date, id) DESC, id DESC LIMIT ${maxLimit} OFFSET ${skipOffset}`;

    let result = await queryTurso(sql, args);

    if ((!result.rows || result.rows.length === 0) && (locClean || roleClean)) {
      result = await queryTurso(
        `SELECT id, id as hash, title, company, location, COALESCE(description, '') as description, url, source, COALESCE(tags, '') as role_category, COALESCE(match_score, 0) as score, COALESCE(date, '') as created_at FROM unified_jobs ORDER BY COALESCE(date, id) DESC, id DESC LIMIT ${maxLimit} OFFSET ${skipOffset}`
      );
    }

    jobs = (result.rows || []).map(row => ({
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
        totalInDb: totalCount || jobs.length,
        total: jobs.length,
        offset: skipOffset,
        jobs: jobs,
      });
    }
  } catch (dbError) {
    primaryError = String(dbError.stack || dbError.message || dbError);
    console.warn("Turso DB Primary err:", dbError);
  }

  // Fallback to Render Go API when Turso returns 0 jobs or errors out
  try {
    const renderResp = await fetch('https://job-search-api-go.onrender.com/jobs?limit=' + maxLimit, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (renderResp.ok) {
      const rawData = await renderResp.json();
      const jobsList = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.jobs) ? rawData.jobs : []);
      const totalDb = (rawData && (rawData.total || rawData.totalInDb || rawData.count)) || jobsList.length;

      if (jobsList.length > 0) {
        return res.status(200).json({
          success: true,
          totalInDb: totalDb || jobsList.length,
          total: jobsList.length,
          offset: skipOffset,
          primary_error: primaryError || undefined,
          count_error: countError || undefined,
          fallback: 'render-go',
          jobs: jobsList.map(j => ({
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
    } else {
      fallbackError = `Render HTTP ${renderResp.status}`;
    }
  } catch (fallbackErr) {
    fallbackError = String(fallbackErr.message || fallbackErr);
  }

  return res.status(200).json({
    success: true,
    totalInDb: totalCount || 0,
    total: 0,
    offset: skipOffset,
    primary_error: primaryError || 'No primary error reported',
    count_error: countError || 'No count error reported',
    fallback_error: fallbackError || 'No fallback error reported',
    jobs: [],
  });
}
