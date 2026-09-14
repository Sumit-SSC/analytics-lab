const https = require('https');

const TURSO_URL = 'https://jobs-db-mitsu.aws-ap-south-1.turso.io/v2/pipeline';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODcyOTA3NDUsImlkIjoiMDE5ZjhlZjUtN2MwMS03OTNhLWI4NWEtYmRkYzUxZjM1Mzk2Iiwia2lkIjoiNmNlY282ZndLZEdseG9IMzJ0ZU1Oc1hEX3gxU0xCQXMtQzZHYW1YTFZCUSIsInJpZCI6IjhiY2Q3YjQ2LWIwZDEtNDEzNC05YjMyLTZkM2MxYzdkNmU3NSJ9.7JgajPE4xibTALh94uAPyDpHs_Un_V0CZq4EzrF7o5rrtpWk1_xT2qoU0omyBVnrYT7I85h2oJxEjzKZuo3sDw';

function httpsPost(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(bodyObj);
    const parsedUrl = new URL(urlStr);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function httpsGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

async function queryTurso(sql, args = []) {
  const formattedArgs = args.map(a => ({ type: 'text', value: String(a) }));
  const data = await httpsPost(TURSO_URL, {
    'Authorization': 'Bearer ' + TURSO_TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  }, {
    requests: [{ type: 'execute', stmt: { sql, args: formattedArgs } }]
  });

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

module.exports = async function handler(req, res) {
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

  let primaryError = null;
  let countError = null;
  let jobs = [];
  let totalCount = 0;

  try {
    try {
      const countRes = await queryTurso('SELECT COUNT(1) as cnt FROM unified_jobs');
      if (countRes.rows && countRes.rows.length > 0) {
        totalCount = Number(countRes.rows[0].cnt) || 0;
      }
    } catch (cntErr) {
      countError = cntErr.message;
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
      sql += ` AND (LOWER(title) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(description) LIKE ?)`;
      const rolePattern = `%${roleClean}%`;
      args.push(rolePattern, rolePattern, rolePattern);
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
    primaryError = dbError.stack || dbError.message;
    console.warn("Turso DB Primary err:", dbError);
  }

  // Fallback to Render Go API when Turso returns 0 jobs or errors out
  try {
    const rawData = await httpsGet('https://job-search-api-go.onrender.com/jobs?limit=' + maxLimit, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    });
    const jobsList = Array.isArray(rawData) ? rawData : (rawData && Array.isArray(rawData.jobs) ? rawData.jobs : []);
    const totalDb = (rawData && (rawData.total || rawData.totalInDb || rawData.count)) || jobsList.length;

    if (jobsList.length > 0) {
      return res.status(200).json({
        success: true,
        totalInDb: totalDb || jobsList.length,
        total: jobsList.length,
        offset: skipOffset,
        primary_error: primaryError,
        count_error: countError,
        fallback: 'render-go',
        jobs: jobsList,
      });
    }
  } catch (fallbackErr) {}

  return res.status(200).json({
    success: true,
    totalInDb: totalCount || 0,
    total: 0,
    offset: skipOffset,
    primary_error: primaryError,
    count_error: countError,
    jobs: [],
  });
};
