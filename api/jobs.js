import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let dbUrl = process.env.TURSO_DATABASE_URL || process.env.DB_URL || 'https://jobs-db-mitsu.aws-ap-south-1.turso.io';
  if (dbUrl.startsWith('turso://')) {
    dbUrl = dbUrl.replace('turso://', 'https://');
  } else if (dbUrl.startsWith('libsql://')) {
    dbUrl = dbUrl.replace('libsql://', 'https://');
  }
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.DB_AUTH_TOKEN || '';

  const { location = '', role = '', limit = '50', offset = '0' } = req.query;
  const maxLimit = Math.min(parseInt(limit, 10) || 50, 500);
  const skipOffset = Math.max(parseInt(offset, 10) || 0, 0);

  if (authToken) {
    try {
      const client = createClient({
        url: dbUrl,
        authToken: authToken,
      });

      let totalCount = 0;
      try {
        const countRes = await client.execute({ sql: `SELECT COUNT(1) as cnt FROM jobs`, args: [] });
        if (countRes.rows && countRes.rows.length > 0) {
          totalCount = Number(countRes.rows[0].cnt);
        }
      } catch (e) {
        console.warn("Could not fetch total count:", e);
      }

      let query = `SELECT id, hash, title, company, location, COALESCE(description, '') as description, url, source, role_category, score, COALESCE(created_at, '') as created_at FROM jobs WHERE 1=1`;
      const args = [];

      if (location && location !== 'all') {
        query += ` AND (LOWER(location) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push(`%${location.toLowerCase()}%`, `%${location.toLowerCase()}%`);
      }

      if (role && role !== 'all') {
        query += ` AND (LOWER(title) LIKE ? OR LOWER(role_category) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push(`%${role.toLowerCase()}%`, `%${role.toLowerCase()}%`, `%${role.toLowerCase()}%`);
      }

      query += ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
      args.push(maxLimit, skipOffset);

      const result = await client.execute({ sql: query, args });

      const jobs = result.rows.map(row => ({
        id: row.id,
        hash: row.hash,
        title: row.title,
        company: row.company,
        location: row.location,
        description: row.description,
        url: row.url,
        source: row.source,
        role_category: row.role_category,
        score: row.score,
        created_at: row.created_at,
      }));

      // Sort by created_at descending (latest first)
      jobs.sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        if (dateB !== dateA) return dateB - dateA;
        return (b.id || 0) - (a.id || 0);
      });

      return res.status(200).json({
        success: true,
        totalInDb: totalCount || jobs.length,
        total: jobs.length,
        offset: skipOffset,
        jobs: jobs,
      });
    } catch (dbError) {
      console.warn("Turso DB query error, falling back to Service 1 Go API:", dbError);
    }
  }

  // Fallback to Service 1 Go Master API on Koyeb
  try {
    const fallbackResp = await fetch('https://typical-diana-mitsu96-df9a3fcc.koyeb.app/api/jobs?limit=' + maxLimit);
    if (fallbackResp.ok) {
      const rawJobs = await fallbackResp.json();
      let jobsList = Array.isArray(rawJobs) ? rawJobs : [];
      jobsList.sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA;
      });
      return res.status(200).json({
        success: true,
        totalInDb: jobsList.length,
        total: jobsList.length,
        offset: skipOffset,
        jobs: jobsList,
      });
    }
  } catch (fallbackError) {
    console.error("Fallback error:", fallbackError);
  }

  return res.status(200).json({
    success: true,
    totalInDb: 0,
    total: 0,
    offset: skipOffset,
    jobs: [],
  });
}
