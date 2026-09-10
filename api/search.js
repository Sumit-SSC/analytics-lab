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

  const { q = '', limit = '24' } = req.query;
  const maxLimit = Math.min(parseInt(limit, 10) || 24, 100);

  if (authToken) {
    try {
      const client = createClient({
        url: dbUrl,
        authToken: authToken,
      });

      let query = `SELECT id, hash, title, company, location, COALESCE(description, '') as description, url, source, role_category, score, COALESCE(created_at, '') as created_at FROM jobs WHERE 1=1`;
      const args = [];

      if (q) {
        const pattern = `%${q.trim().toLowerCase()}%`;
        query += ` AND (LOWER(title) LIKE ? OR LOWER(company) LIKE ? OR LOWER(location) LIKE ? OR LOWER(description) LIKE ?)`;
        args.push(pattern, pattern, pattern, pattern);
      }

      query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
      args.push(maxLimit);

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
        query: q,
        total: jobs.length,
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
      let filtered = rawJobs;
      if (q) {
        const lowerQ = q.toLowerCase();
        filtered = rawJobs.filter(j =>
          (j.title && j.title.toLowerCase().includes(lowerQ)) ||
          (j.company && j.company.toLowerCase().includes(lowerQ)) ||
          (j.location && j.location.toLowerCase().includes(lowerQ))
        );
      }
      filtered.sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA;
      });
      return res.status(200).json({
        success: true,
        query: q,
        total: filtered.length,
        jobs: filtered,
      });
    }
  } catch (fallbackError) {
    console.error("Fallback error:", fallbackError);
  }

  return res.status(200).json({
    success: true,
    query: q,
    total: 0,
    jobs: [],
  });
}
